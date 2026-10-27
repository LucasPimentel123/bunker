// Guided account discovery plus explicit guardian recovery. Asset withdrawals remain demonstrative.
import { formatUnits, getAddress } from 'viem';
import { readGuidedRecovery, performGuidedRecovery, checkGuidedRecoveryReceipts } from './guided-recovery';
import { checkExternalAccess } from './guided-access';
import { discoverPasskey, confirmPasskey, resetPasskey } from './guided-passkey';
import { chains, defaultReadRpcs } from '../catalog/chains';
import { discoverExternalCandidates } from '../core/externalDiscovery';
import { diagnoseNetwork, emptyDiagnosis, type NetworkDiagnosis } from '../core/diagnosis';
import { discoverCards } from '../core/discovery';
import { ReadPool } from '../core/reads';
import { migrationItems } from '../components/migration';

const sources = (id: number) => {
  const chain = chains.find(c => c.id === id)!;
  return (id === 1 ? ['https://eth.drpc.org', ...defaultReadRpcs(chain)] : defaultReadRpcs(chain)).map(url => ({ url }));
};
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
      count: items.length, guardians: result.snapshot?.recoveries.flatMap(r => r.guardians) ?? [] };
  }) };
}
async function scan(value: string, signal: AbortSignal, progress: (done: number, total: number) => void) {
  const account = getAddress(value), startedAt = new Date().toISOString();
  const results = new Map(chains.map(c => [c.id, emptyDiagnosis(c.id, account)]));
  let done = 0;
  await Promise.all(chains.map(async chain => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
    try {
      await diagnoseNetwork({ chain, account, sources: sources(chain.id), signal: bounded, waitLimit: 1000, update: result => results.set(chain.id, result) });
      bounded.throwIfAborted();
      if (chain.id === 100) {
        const cards = await discoverCards(new ReadPool(chain, sources(100), bounded, 1000), account);
        const linkedCards: NetworkDiagnosis[] = [];
        for (const card of cards.addresses) {
          let latest = emptyDiagnosis(100, card);
          await diagnoseNetwork({ chain, account: card, sources: sources(100), signal: bounded, waitLimit: 1000, update: result => latest = result });
          linkedCards.push(latest);
        }
        const original = results.get(100)!;
        results.set(100, { ...original, linkedCards, issues: [...original.issues, ...cards.issues], status: cards.issues.length && original.status === 'complete' ? 'partial' : original.status });
      }
    } catch {
      signal.throwIfAborted();
      const previous = results.get(chain.id)!;
      results.set(chain.id, { ...previous, status: previous.snapshot ? 'partial' : 'unavailable', issues: [...previous.issues, 'Consulta não concluída; saldos ausentes são desconhecidos.'] });
    } finally { if (!signal.aborted) progress(++done, chains.length); }
  }));
  signal.throwIfAborted();
  return inventory(account, results, startedAt);
}
const api = {
  recovery: { read: readGuidedRecovery, perform: performGuidedRecovery, receipts: checkGuidedRecoveryReceipts },
  discover: (wallet: string, signal: AbortSignal) => discoverExternalCandidates(getAddress(wallet), {}, AbortSignal.any([signal, AbortSignal.timeout(180_000)])),
  checkAccess: (account: string, wallet: string, signal: AbortSignal) => checkExternalAccess(account, wallet, AbortSignal.any([signal, AbortSignal.timeout(120_000)])), scan, discoverPasskey, confirmPasskey, resetPasskey,
};
Object.assign(window, { picnicGuidedDiscovery: api });
