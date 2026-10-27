import { getAddress, keccak256, type Address, type EIP1193Provider, type Hex, type PublicClient } from 'viem';
import { chainById } from '../catalog/chains';
import { address, publicClient, same } from '../core/client';
import { discoveryRpc } from '../core/ownerHistory';
import { inspectAccount } from '../core/inspect';
import { batchSources, type MigrationItem } from '../components/migration';
import { batchPartAction, includedEntries, planBatch, readBatchFacts, screenAssetTransfers, type BatchEntry } from '../core/batch';
import { findMultiSend } from '../core/multisend';
import { sendAction, type SendHooks } from '../core/actions';
import { verifyReceipt, type ReceiptExpectation } from '../core/receipts';
import { dispatchCard, skipExpiredCard, queueStatus, queuedTransfer, readQueue } from '../core/card';
import type { PreparedAction } from '../core/types';
import { assertLocalBunker } from '../proof/localBunker';
import { authorizeWithdrawal, withdrawalIdentity } from './guided-passkey';

type Request = { account: string; chainId: number; payer: string; destination: string; method: 'passkey' | 'wallet'; ids: string[] };
type Pending = { intent: {from: Address; to: Address; dataHash: Hex; value: string}; account: Address; chainId: number; hash: Hex; expectation: ReceiptExpectation; completed: string[]; destination: Address; queued: boolean };
let memory: Pending[] = [];
const journalKey = 'picnic-bunker-withdrawals-v1';
const stages = { wallet: 'Conferindo a carteira…', network: 'Confirme a troca de rede na carteira…', validation: 'Validando permissões e saldos…', simulation: 'Simulando a retirada e estimando a taxa…', signature: 'Autorize esta retirada com sua passkey…', transaction: 'Confirme o envio na carteira que paga as taxas…' };
const reader = (id: number, signal?: AbortSignal) => publicClient(chainById(id), discoveryRpc(id), 20_000, signal);
function records(): Pending[] {
  const value = JSON.parse(localStorage.getItem(journalKey) ?? '[]');
  if (!Array.isArray(value) || value.some(r => !/^0x[\da-f]{64}$/i.test(r.hash) || !/^0x[\da-f]{40}$/i.test(r.account) || !/^0x[\da-f]{40}$/i.test(r.destination) || !Number.isSafeInteger(r.chainId) || !Array.isArray(r.completed) || r.completed.some((id: unknown) => typeof id !== 'string') || !r.expectation || !/^0x[\da-f]{40}$/i.test(r.intent?.from) || !/^0x[\da-f]{40}$/i.test(r.intent?.to) || !/^0x[\da-f]{64}$/i.test(r.intent?.dataHash) || !/^\d+$/.test(r.intent?.value))) throw Error('Histórico de retirada inválido. Confira os recibos antes de continuar.');
  return [...new Map([...value,...memory].map(r=>[r.hash,r])).values()];
}
function save(value: Pending[]) { localStorage.setItem(journalKey, JSON.stringify(value)); memory=value; }
const context = () => assertLocalBunker(location.origin, window.isSecureContext);
export function createGuidedWithdrawal(itemsFor: (account: Address) => MigrationItem[], dependencies: { reader?: typeof reader; identity?: typeof withdrawalIdentity; authorize?: typeof authorizeWithdrawal; context?: typeof context } = {}) {
  const read = dependencies.reader ?? reader, identityFor = dependencies.identity ?? withdrawalIdentity, authorize = dependencies.authorize ?? authorizeWithdrawal, checkContext = dependencies.context ?? context;
  type Plan = { request: Request; action: PreparedAction; completed: string[]; queued: boolean; identity?: ReturnType<typeof withdrawalIdentity> };
  const plans = new Map<string, Plan>();
  let sending = false;
  async function prepare(request: Request, signal: AbortSignal) {
    checkContext();signal.throwIfAborted();
    if (sending) throw Error('Uma retirada já está em andamento.');
    const account = address(request.account), payer = address(request.payer), destination = address(request.destination);
    if (same(account, destination) || same(account, payer)) throw Error('Use uma carteira externa à Safe para pagar as taxas e receber os ativos.');
    const pending = records().find(r => same(r.account, account) && r.chainId === request.chainId);
    if (pending) return { status: 'pending' as const, hash: pending.hash, destination: pending.destination, message: 'Uma transação foi enviada. Confira o resultado antes de continuar.' };
    // Fail before asking for any signature when receipt persistence is unavailable.
    save(records());
    const items = itemsFor(account), chosen = items.filter(i => i.chainId === request.chainId && request.ids.includes(i.id));
    if (!chosen.length || new Set(chosen.map(i => i.id)).size !== new Set(request.ids).size || chosen.some(i => !i.selectable)) throw Error('A seleção mudou. Consulte os ativos novamente.');
    const client = read(request.chainId, signal), snapshot = await inspectAccount(client, account, request.chainId);
    const identity = request.method === 'passkey' ? identityFor(account) : undefined;
    let owner = payer;
    if (identity) {
      const { diagnose } = await import('../proof/simulation');
      const diagnosis = await diagnose(client, account, request.chainId);
      const signer = diagnosis.signers.find(s => same(s.x, identity.key.x) && same(s.y, identity.key.y));
      if (!signer) throw Error('Esta passkey não controla a conta nesta rede.');
      owner = signer.address; identity.assertCurrent();
    } else if (!snapshot.owners.some(o => same(o, payer))) throw Error('A carteira conectada não controla esta conta. Recupere o acesso primeiro.');
    const sources = batchSources(chosen, request.chainId), multicall = chainById(request.chainId).contracts?.multicall3?.address;
    const facts = await readBatchFacts(client, snapshot, sources, multicall);
    // A queued card withdrawal is a separate, explicit transaction after cooldown.
    const waits: string[] = [];
    for (const fact of facts) if ((fact.kind === 'card' || fact.kind === 'card-queue') && fact.delay && fact.delay.tail > fact.delay.head) {
      const queued = (await readQueue(client, fact.delay))[0];
      if (!queued) throw Error('A fila do cartão não pôde ser verificada.');
      let effect;
      try { effect = queuedTransfer(queued); }
      catch { waits.push('A fila do cartão contém uma operação que precisa de revisão individual.'); continue; }
      if(fact.kind==='card' && (fact.asset==='native' ? effect.token!==null : !effect.token || !same(fact.asset,effect.token))) {
        waits.push('A primeira retirada na fila é de outro ativo. Inclua a fila do cartão na seleção para revisá-la.');continue;
      }
      if (!same(effect.recipient, destination)) { waits.push('O cartão tem uma retirada pendente para outro destino. Confira essa solicitação antes de continuar.'); continue; }
      const status = queueStatus(queued.createdAt, fact.delay.cooldown, fact.delay.expiration, snapshot.timestamp);
      if (status === 'waiting') { waits.push(`O cartão libera esta retirada a partir de ${new Date(Number(queued.createdAt + fact.delay.cooldown) * 1000).toLocaleString('pt-BR')}.`); continue; }
      const action = status==='expired'?await skipExpiredCard(client,fact.delay,request.chainId):await dispatchCard(client, fact.delay, queued, request.chainId);
      // Card dispatch is permissionless, but bind this payer, destination and amount.
      action.expectedSender = payer; action.allowGuardianRecipient = true;
      const id = crypto.randomUUID();plans.clear();plans.set(id, {request: structuredClone(request), action, completed: [], queued: false});
      signal.throwIfAborted();
      return { status: 'ready' as const, id, parts: 1, count: 1, label: status==='expired'?'Descartar solicitação expirada':'Liberar retirada do cartão', entries: [{label: fact.label, outcome: status==='expired'?'expired':'received'}], notes: [], card: true };
    }
    const multisend = (await findMultiSend(client, request.chainId))?.address;
    const initial = planBatch({snapshot,destination,facts,multisend,allowGuardianRecipient:true});
    if (initial.unavailable) throw Error(`A migração em lote não está disponível nesta rede (${initial.unavailable}).`);
    const screened = await screenAssetTransfers(client, snapshot, facts, destination, owner, multisend);
    const plan = planBatch({snapshot,destination,facts:screened,multisend,allowGuardianRecipient:true});
    const included = includedEntries(plan, 0), notes = [...new Set([...waits, ...plan.entries.flatMap(e => e.status === 'empty' ? [] : [...e.notes.filter(() => e.status !== 'included'), ...e.later])])];
    signal.throwIfAborted();identity?.assertCurrent();
    if (!included.length) return {status: plan.entries.every(e => e.status === 'empty') ? 'empty' as const : 'blocked' as const, notes, entries: plan.entries.map(e => ({label:e.label,status:e.status})), message: notes.join(' ') || 'Estes ativos precisam de uma etapa individual antes da retirada.'};
    const action = batchPartAction({snapshot,plan,part:0,label:'Retirada Bunker',reread:async()=>readBatchFacts(client,await inspectAccount(client,account,request.chainId),sources,multicall)});
    action.expectedSender=payer;action.allowGuardianRecipient=true;
    const id=crypto.randomUUID();plans.clear();plans.set(id,{request:structuredClone(request),action,identity,completed:included.filter(e=>e.outcome!=='queued'&&!e.later.length).map(e=>e.id),queued:included.some(e=>e.outcome==='queued')});
    return {status:'ready' as const,id,parts:plan.parts.length,count:included.length,label:'Retirar ativos',entries:included.map((e:BatchEntry)=>({label:e.label,outcome:e.outcome})),notes};
  }
  async function execute(id: string, provider: EIP1193Provider, signal: AbortSignal, progress: (message:string)=>void) {
    checkContext();signal.throwIfAborted();const plan=plans.get(id);
    if(!plan||sending)throw Error('Prepare a retirada novamente.');
    const {request,action}=plan;
    if(records().some(r=>same(r.account,request.account)&&r.chainId===request.chainId))throw Error('Confira a transação enviada antes de repetir.');
    save(records());sending=true;plans.delete(id);
    // Do not abort receipt reads after broadcasting. Retain the journal on every failure.
    const client=read(request.chainId);
    let intent: Pending['intent'] | undefined;
    const guardProvider: EIP1193Provider={on: provider.on?.bind(provider), removeListener: provider.removeListener?.bind(provider), request:async(args)=>{
      signal.throwIfAborted();plan.identity?.assertCurrent();
      if(['eth_sendTransaction','eth_signTypedData_v4'].includes(args.method)) {
        const accounts=await provider.request({method:'eth_accounts'});
        if(!same(accounts[0]??'',request.payer)||Number(await provider.request({method:'eth_chainId'}))!==request.chainId)throw Error('A carteira ou rede mudou. Prepare novamente.');
        signal.throwIfAborted();
        if(args.method==='eth_sendTransaction'){
          const tx=(args.params as [{from:Address;to:Address;data?:Hex;value?:Hex}])[0];
          intent={from:tx.from,to:tx.to,dataHash:keccak256(tx.data??'0x'),value:BigInt(tx.value??'0x0').toString()};
        }
      }
      return provider.request(args as never);
    }};
    try {
      const hooks: SendHooks={preflightGas:true,onSigning:stage=>{signal.throwIfAborted();progress(stage==='signature'&&request.method==='wallet'?'Autorize a proposta na sua carteira…':stages[stage]);},onSubmitted:(hash,expectation)=>{
        if(!intent)throw Error('Transação enviada, mas não foi possível registrar os dados. Confira sua carteira antes de repetir.');
        const record={account:getAddress(request.account),chainId:request.chainId,hash,expectation:expectation!,completed:plan.completed,destination:getAddress(request.destination),queued:plan.queued,intent};
        memory=[...memory,record];save(records());
        progress('Transação enviada. Aguardando duas confirmações…');
      },...(plan.identity?{authorizeContract:(hash:Hex,snapshot:Parameters<typeof authorizeWithdrawal>[2])=>authorize(plan.identity!,hash,snapshot,client,signal)}:{})};
      const receipt=await sendAction(client,guardProvider,action,hooks);
      save(records().filter(r=>r.hash!==receipt.transactionHash));
      return {hash:receipt.transactionHash,completed:plan.completed,queued:plan.queued,destination:request.destination};
    } catch(error) {
      const submitted=memory.find(r=>same(r.account,request.account)&&r.chainId===request.chainId);
      if(submitted)throw Object.assign(error instanceof Error?error:Error(String(error)),{pendingHash:submitted.hash});
      throw error;
    }finally{sending=false;}
  }
  async function receipt(account: string, chainId: number, signal: AbortSignal) {
    checkContext();const found=records().find(r=>same(r.account,account)&&r.chainId===chainId);if(!found)throw Error('Nenhum recibo pendente nesta rede.');
    const client=read(chainId,signal), result=await client.getTransactionReceipt({hash:found.hash});
    if(await client.getBlockNumber()<result.blockNumber+1n)throw Error('Aguardando duas confirmações.');
    if(result.status==='reverted'){save(records().filter(r=>r.hash!==found.hash));throw Error('A transação reverteu. Prepare a retirada novamente.');}
    const tx=await client.getTransaction({hash:found.hash});
    if(!same(tx.from,found.intent.from)||!tx.to||!same(tx.to,found.intent.to)||keccak256(tx.input)!==found.intent.dataHash||tx.value!==BigInt(found.intent.value))throw Error('O recibo não corresponde à retirada registrada.');
    verifyReceipt(result,found.expectation);save(records().filter(r=>r.hash!==found.hash));
    return {hash:found.hash,completed:found.completed,queued:found.queued,destination:found.destination};
  }
  return {prepare,execute,receipt};
}
