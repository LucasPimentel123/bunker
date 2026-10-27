// Guided account discovery, guardian recovery and explicit user-approved withdrawals.
import { formatUnits, getAddress } from 'viem';
import { readGuidedRecovery, performGuidedRecovery, checkGuidedRecoveryReceipts } from './guided-recovery';
import { checkExternalAccess } from './guided-access';
import { discoverPasskey, confirmPasskey, resetPasskey } from './guided-passkey';
import { chains, defaultReadRpcs } from '../catalog/chains';
import { discoverExternalCandidates } from '../core/externalDiscovery';
import { diagnoseNetwork, emptyDiagnosis, type NetworkDiagnosis } from '../core/diagnosis';
import { discoverCards } from '../core/discovery';
import { ReadPool, type ReadCheckpoint } from '../core/reads';
import { createGuidedWithdrawal } from './guided-withdrawal';
import { migrationItems } from '../components/migration';

const sources = (id: number) => {
  const chain = chains.find(c => c.id === id)!;
  return (id === 1 ? ['https://eth.drpc.org', ...defaultReadRpcs(chain)] : defaultReadRpcs(chain)).map(url => ({ url }));
};
let cardContext = '';
let cardCheckpoint: ReadCheckpoint = new Map();
let completedScan: { account: string; results: Map<number, NetworkDiagnosis>; base: NetworkDiagnosis; startedAt: string } | undefined;
async function scanCards(base: NetworkDiagnosis, signal: AbortSignal) {
  const chain = chains.find(c => c.id === 100)!;
  const cards = await discoverCards(new ReadPool(chain, sources(100), signal, 1000, undefined, cardCheckpoint), base.account);
  const linkedCards: NetworkDiagnosis[] = [];
  for (const card of cards.addresses) {
    let latest = emptyDiagnosis(100, card);
    await diagnoseNetwork({ chain, account: card, sources: sources(100), signal, waitLimit: 1000, update: result => latest = result });
    linkedCards.push(latest);
  }
  const childIncomplete = linkedCards.some(card => card.status !== 'complete');
  const issues = [...base.issues, ...cards.issues, ...(childIncomplete ? ['Alguns saldos dos cartões ainda não puderam ser consultados.'] : [])];
  return { ...base, linkedCards, issues, status: issues.length && base.status === 'complete' ? 'partial' as const : base.status };
}
async function retryCards(value: string, signal: AbortSignal) {
  const account = getAddress(value), previous = completedScan;
  if (!previous || previous.account !== account || cardContext !== account) throw Error('Consulte esta conta novamente antes de buscar os cartões.');
  const updated = await scanCards(previous.base, AbortSignal.any([signal, AbortSignal.timeout(150_000)]));
  signal.throwIfAborted();
  if (completedScan !== previous || cardContext !== account) throw Error('A conta mudou.');
  previous.results.set(100, updated);
  return inventory(account, previous.results, previous.startedAt);
}
function inventory(account: string, results: Map<number, NetworkDiagnosis>, startedAt: string) {
  return { account, startedAt, checkedAt: new Date().toISOString(), networks: chains.map(chain => {
    const result = results.get(chain.id)!;
    const items = migrationItems([result], []).map(item => ({
      id: item.id, name: item.kind === 'baskets' ? `Cesta ${item.symbol}` : item.symbol || item.name,
      description: item.name, kind: item.kind, selectable: item.selectable,
      balance: item.amount ? item.amount.decimals === undefined ? 'Unidade não verificada' : formatUnits(item.amount.value, item.amount.decimals) : item.count ?? (item.pending ? 'Pendente' : 'A consultar'),
    }));
    return { id: String(chain.id), chainId: chain.id, name: chain.name, symbol: chain.nativeCurrency.symbol,
      status: result.status, issues: result.issues, block: result.snapshot?.block.toString(), items,
      checkedTokens: result.checkedTokens, totalTokens: result.totalTokens, failedTokens: result.failedTokens,
      unreadableTokens: result.unreadableTokens.length, sources: result.sources,
      count: items.length, guardians: result.snapshot?.recoveries.flatMap(r => r.guardians) ?? [] };
  }) };
}
async function scan(value: string, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const account = getAddress(value), startedAt = new Date().toISOString();
  completedScan = undefined;
  if (cardContext !== account) { cardContext = account; cardCheckpoint = new Map(); }
  let cardBase = emptyDiagnosis(100, account);
  const results = new Map(chains.map(c => [c.id, emptyDiagnosis(c.id, account)]));
  let done = 0;
  await Promise.all(chains.map(async chain => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
    try {
      await diagnoseNetwork({ chain, account, sources: sources(chain.id), signal: bounded, waitLimit: 1000, update: result => results.set(chain.id, result) });
      bounded.throwIfAborted();
      if (chain.id === 100) {
        cardBase = results.get(100)!;
        results.set(100, await scanCards(cardBase, bounded));
      }
    } catch {
      signal.throwIfAborted();
      const previous = results.get(chain.id)!;
      const reason = bounded.aborted ? 'A consulta atingiu o tempo limite desta rede. Os saldos ainda não consultados continuam desconhecidos.' : 'Consulta não concluída; saldos ausentes são desconhecidos.';
      results.set(chain.id, { ...previous, status: previous.snapshot ? 'partial' : 'unavailable', issues: [...previous.issues, reason] });
    } finally { if (!signal.aborted) progress(++done, chains.length); }
  }));
  signal.throwIfAborted();
  completedScan = { account, results, base: cardBase, startedAt };
  return inventory(account, results, startedAt);
}
const withdrawal = createGuidedWithdrawal(account => {
  if(!completedScan || completedScan.account.toLowerCase()!==account.toLowerCase()) throw Error('Consulte os ativos desta conta novamente.');
  return migrationItems([...completedScan.results.values()],[]);
});
const api = {
  withdrawal,
  recovery: { read: readGuidedRecovery, perform: performGuidedRecovery, receipts: checkGuidedRecoveryReceipts },
  discover: (wallet: string, signal: AbortSignal) => discoverExternalCandidates(getAddress(wallet), {}, AbortSignal.any([signal, AbortSignal.timeout(180_000)])),
  checkAccess: (account: string, wallet: string, signal: AbortSignal) => checkExternalAccess(account, wallet, AbortSignal.any([signal, AbortSignal.timeout(120_000)])), scan, retryCards, discoverPasskey, confirmPasskey, resetPasskey,
};
Object.assign(window, { picnicGuidedDiscovery: api });
