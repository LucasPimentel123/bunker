import { type Address, type EIP1193Provider, type Hex } from 'viem';
import { chainById } from '../catalog/chains';
import { address, publicClient, same } from '../core/client';
import { discoveryRpc } from '../core/ownerHistory';
import { knownGuardians, newOwnerError } from '../core/destination';
import { readRecoveryPreparation, recoveryPermissions } from '../core/recoveryPreparation';
import { recoveryAction, sendAction, type SendHooks } from '../core/actions';
import { verifyReceipt, type ReceiptExpectation } from '../core/receipts';
import { assertLocalBunker } from '../proof/localBunker';
import { checkExternalAccess } from './guided-access';

type Operation = 'approve' | 'start' | 'finalize';
type Submitted = { account: Address; chainId: number; hash: Hex; expectation?: ReceiptExpectation };
const journalKey = 'picnic-bunker-guardian-transactions-v1';
let sending = false;
const context = () => assertLocalBunker(location.origin, window.isSecureContext);
const reader = (chainId: number, signal?: AbortSignal) => publicClient(chainById(chainId), discoveryRpc(chainId), 20_000, signal);
function pending(): Submitted[] {
  const value = JSON.parse(localStorage.getItem(journalKey) ?? '[]');
  if (!Array.isArray(value) || value.some(t => !/^0x[\da-f]{64}$/i.test(t.hash) || !/^0x[\da-f]{40}$/i.test(t.account) || !Number.isInteger(t.chainId))) throw Error('Histórico de transações inválido. Confira os recibos antes de continuar.');
  return value;
}
function save(value: Submitted[]) { localStorage.setItem(journalKey, JSON.stringify(value)); }
async function load(accountValue: string, walletValue: string, owner: string, signal: AbortSignal, excluded: number[] = []) {
  context();
  const account = address(accountValue), wallet = address(walletValue);
  const access = await checkExternalAccess(account, wallet, signal);
  const data = await Promise.all(access.networks.filter(n => n.snapshot).map(async n => {
    try { return { chainId: n.chainId, data: await readRecoveryPreparation(reader(n.chainId, signal), account, n.chainId, wallet, owner) }; }
    catch { signal.throwIfAborted(); return { chainId: n.chainId, data: undefined }; }
  }));
  signal.throwIfAborted();
  const guardians = knownGuardians([...access.networks.map(n => n.snapshot), ...data.map(n => n.data?.snapshot)], account);
  // Excluding a network only removes it from the recovery scope. Keep every
  // known guardian in the union, and revalidate the target network before signing.
  const included = data.filter(n => !excluded.includes(n.chainId));
  const complete = !access.networks.some(n => n.status === 'unknown' && !excluded.includes(n.chainId)) && included.length > 0 && included.every(n => n.data);
  const problem = owner.trim() ? same(owner.trim(), wallet) ? 'connected' : data.flatMap(n => n.data ? [newOwnerError(owner, n.data.snapshot, guardians)] : []).find(Boolean) : 'missing';
  return { account, wallet, access, data, guardians, complete, problem };
}
export async function readGuidedRecovery(account: string, wallet: string, owner: string, signal: AbortSignal, excluded: number[] = []) {
  const result = await load(account, wallet, owner, signal, excluded);
  return {
    account: result.account, wallet: result.wallet, owner, complete: result.complete, ownerProblem: result.problem, guardians: result.guardians,
    pending: pending().filter(t => same(t.account, result.account)),
    networks: result.data.filter(n => !excluded.includes(n.chainId)).flatMap(n => n.data ? [{ chainId: n.chainId, name: chainById(n.chainId).name,
      symbol: chainById(n.chainId).nativeCurrency.symbol, gas: n.data.gas.toString(), owners: n.data.snapshot.owners,
      recovered: n.data.snapshot.threshold === 1n && !!owner.trim() && same(n.data.snapshot.owners[0], owner.trim()),
      modules: n.data.snapshot.recoveries.filter(r => r.supported && r.threshold > 0n).map(r => {
        const permissions = recoveryPermissions(n.data!, r, result.wallet, owner, result.guardians);
        const pendingProblem = r.pending.executeAfter > 0n && (r.pending.newOwners.length !== 1 || r.pending.newThreshold !== 1n || same(r.pending.newOwners[0], result.wallet) || !!newOwnerError(r.pending.newOwners[0], n.data!.snapshot, result.guardians));
        return { module: r.module, guardian: permissions.guardian, period: String(r.period ?? 0n), until: String(r.pending.executeAfter),
          newOwners: r.pending.newOwners, threshold: String(r.threshold), approvals: String(permissions.approvals?.count ?? r.pending.guardiansApprovalCount),
          approved: permissions.approvals?.approved ?? false, pendingProblem,
          operation: result.complete && !pendingProblem && !result.problem && permissions.approve ? 'approve' :
            result.complete && !pendingProblem && !result.problem && permissions.start ? 'start' :
              result.complete && !pendingProblem && permissions.finalize ? 'finalize' : undefined };
      }),
    }] : []),
    incompleteNetworks: [...new Set([...result.access.networks.filter(n => n.status === 'unknown').map(n => n.chainId), ...result.data.filter(n => !n.data).map(n => n.chainId)])].filter(id => !excluded.includes(id)),
    issues: result.access.networks.filter(n => n.status === 'unknown' && !excluded.includes(n.chainId)).map(n => n.name).concat(result.data.filter(n => !n.data && !excluded.includes(n.chainId)).map(n => chainById(n.chainId).name)),
  };
}
export async function performGuidedRecovery(account: string, wallet: string, owner: string, chainId: number, moduleValue: string, operation: Operation, provider: EIP1193Provider, signal: AbortSignal, progress: (message: string) => void, excluded: number[] = []) {
  context();
  if (excluded.includes(chainId)) throw Error('Esta rede foi deixada para depois. Inclua-a novamente antes de recuperar.');
  if (sending) throw Error('Uma operação já está em andamento.');
  if (!['approve', 'start', 'finalize'].includes(operation)) throw Error('Operação inválida.');
  sending = true;
  try {
    // Verify journal availability before requesting a signature. Never retry a
    // broadcast whose receipt remains unknown, including after a page reload.
    const records = pending(); save(records);
    if (records.some(t => same(t.account, account))) throw Error('Confira a transação enviada antes de repetir.');
    progress('Conferindo o guardian, o novo owner e as permissões…');
    const fresh = await load(account, wallet, owner, signal, excluded);
    if (!fresh.complete) throw Error('Não foi possível conferir todas as redes e seus guardians. Tente atualizar.');
    const data = fresh.data.find(n => n.chainId === chainId)?.data;
    const module = address(moduleValue), recovery = data?.snapshot.recoveries.find(r => same(r.module, module));
    if (!data || !recovery) throw Error('Módulo de recuperação não confirmado.');
    const target = operation === 'finalize' ? recovery.pending.newOwners[0] : owner;
    if (!target || same(target, fresh.wallet) || newOwnerError(target, data.snapshot, fresh.guardians)) throw Error('O novo owner deve ser outra carteira sua, diferente da Safe, da carteira conectada e de todos os guardians.');
    const permissions = recoveryPermissions(data, recovery, fresh.wallet, owner, fresh.guardians);
    if (!permissions[operation]) throw Error('Esta operação ainda não está autorizada. Confira as aprovações, o prazo e o saldo para taxas.');
    const action = { ...recoveryAction(data.snapshot, module, operation, owner), expectedSender: fresh.wallet, forbiddenRecipients: fresh.guardians,
      revalidate: async () => { signal.throwIfAborted(); context(); } };
    const messages: Record<NonNullable<Parameters<NonNullable<SendHooks['onSigning']>>[0]>, string> = {
      wallet: 'Verificando a carteira…', network: 'Confirme a troca de rede na carteira.', validation: 'Conferindo o estado da recuperação…',
      simulation: 'Simulando a operação…', signature: 'Assine a autorização de recuperação na carteira.', transaction: 'Confirme a transação na carteira.',
    };
    const receipt = await sendAction(reader(chainId), provider, action, {
      onSigning: stage => { signal.throwIfAborted(); progress(messages[stage]); },
      onSubmitted: (hash, expectation) => { save([...pending(), { account: fresh.account, chainId, hash, expectation }]); progress('Transação enviada. Aguardando confirmação da rede…'); },
    });
    save(pending().filter(t => t.hash !== receipt.transactionHash));
    return { hash: receipt.transactionHash };
  } finally { sending = false; }
}
export async function checkGuidedRecoveryReceipts(account: string, signal: AbortSignal) {
  context();
  for (const record of pending().filter(t => same(t.account, account))) {
    signal.throwIfAborted();
    const client = reader(record.chainId, signal);
    const receipt = await client.getTransactionReceipt({ hash: record.hash });
    const block = await client.getBlockNumber();
    if (block < receipt.blockNumber + 1n) throw Error('A transação ainda aguarda duas confirmações.');
    if (receipt.status === 'reverted') { save(pending().filter(t => t.hash !== record.hash)); throw Error('A transação falhou na rede. Atualize antes de tentar novamente.'); }
    verifyReceipt(receipt, record.expectation);
    save(pending().filter(t => t.hash !== record.hash));
  }
}
