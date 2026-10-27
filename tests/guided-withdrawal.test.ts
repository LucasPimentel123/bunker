import { beforeEach, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { createGuidedWithdrawal } from '../src/prototype/guided-withdrawal';
import { inspectAccount } from '../src/core/inspect';
import { readBatchFacts } from '../src/core/batch';
import { dispatchCard, readQueue, skipExpiredCard } from '../src/core/card';
import { erc20Abi } from '../src/core/abi';
import type { AccountSnapshot } from '../src/core/types';
import type { MigrationItem } from '../src/components/migration';
vi.mock('../src/core/inspect',async original=>({...await original<typeof import('../src/core/inspect')>(),inspectAccount:vi.fn()}));
vi.mock('../src/core/batch',async original=>({...await original<typeof import('../src/core/batch')>(),readBatchFacts:vi.fn()}));
vi.mock('../src/core/card',async original=>({...await original<typeof import('../src/core/card')>(),readQueue:vi.fn(),dispatchCard:vi.fn(),skipExpiredCard:vi.fn()}));
vi.mock('../src/core/multisend',async original=>({...await original<typeof import('../src/core/multisend')>(),findMultiSend:vi.fn(async()=>undefined)}));
const address=(n:string)=>getAddress('0x'+n.repeat(40));
const safe=address('1'),payer=address('2'),dest=address('3'),card=address('4'),module=address('5'),token=address('6'),other=address('7');
const delay={address:module,card,controllers:[safe],delayVersion:'v5' as const,head:0n,tail:1n,cooldown:60n,expiration:0n};
const snapshot:AccountSnapshot={address:safe,chainId:100,block:10n,timestamp:1000n,version:'1.4.1',owners:[payer],threshold:1n,nonce:0n,nativeBalance:0n,modules:[],guard:zeroAddress,moduleGuard:zeroAddress,recoveries:[],warnings:[]};
const item:MigrationItem={id:'100:card:test',chainId:100,kind:'card',name:'Test',symbol:'TEST',order:0,tab:'card',selectable:true,card:delay,holding:{address:token} as MigrationItem['holding']};
const request={account:safe,chainId:100,payer,destination:dest,method:'wallet' as const,ids:[item.id]};
const api=()=>createGuidedWithdrawal(()=>[item],{reader:()=>({} as PublicClient),context:()=>{}});
beforeEach(()=>{
  vi.clearAllMocks();const storage=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  vi.mocked(inspectAccount).mockResolvedValue(snapshot);
  vi.mocked(readBatchFacts).mockResolvedValue([{id:item.id,kind:'card',label:'Test',delay,card,asset:token,balance:10n}]);
  vi.mocked(readQueue).mockResolvedValue([{nonce:0n,hash:'0x1234',createdAt:1n,to:token,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[dest,10n]}),operation:0}]);
  vi.mocked(dispatchCard).mockResolvedValue({kind:'direct',chainId:100,account:card,call:{to:module,value:0n,data:'0x'},label:'Release'});
  vi.mocked(skipExpiredCard).mockResolvedValue({kind:'direct',chainId:100,account:card,call:{to:module,value:0n,data:'0x'},label:'Skip expired'});
});
it('does not execute a queued asset absent from the selection, even when its recipient matches',async()=>{
  vi.mocked(readQueue).mockResolvedValue([{nonce:0n,hash:'0x1234',createdAt:1n,to:other,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[dest,10n]}),operation:0}]);
  const result=await api().prepare(request,new AbortController().signal);
  expect(result.status).toBe('blocked');expect(dispatchCard).not.toHaveBeenCalled();
});
it('keeps another recipient and an unelapsed cooldown blocked',async()=>{
  expect((await api().prepare({...request,destination:other},new AbortController().signal)).status).toBe('blocked');
  vi.mocked(inspectAccount).mockResolvedValue({...snapshot,timestamp:20n});
  expect((await api().prepare(request,new AbortController().signal)).status).toBe('blocked');expect(dispatchCard).not.toHaveBeenCalled();
});
it('offers a ready card release or an explicit expired-request discard, without executing during preparation',async()=>{
  expect((await api().prepare(request,new AbortController().signal)).status).toBe('ready');expect(dispatchCard).toHaveBeenCalledTimes(1);
  vi.mocked(readBatchFacts).mockResolvedValue([{id:item.id,kind:'card',label:'Test',delay:{...delay,expiration:60n},card,asset:token,balance:10n}]);
  const result=await api().prepare(request,new AbortController().signal);expect(result.status).toBe('ready');
  if(result.status==='ready')expect(result.label).toBe('Descartar solicitação expirada');expect(skipExpiredCard).toHaveBeenCalledTimes(1);
});
it('rejects unknown asset IDs, another owner and zero-address destinations before preparing any action',async()=>{
  await expect(api().prepare({...request,ids:['unknown']},new AbortController().signal)).rejects.toThrow(/seleção/);
  await expect(api().prepare({...request,payer:other},new AbortController().signal)).rejects.toThrow(/não controla/);
  await expect(api().prepare({...request,destination:zeroAddress},new AbortController().signal)).rejects.toThrow(/Invalid/);
});
it('does not revive a canceled preparation',async()=>{
  const abort=new AbortController();abort.abort();await expect(api().prepare(request,abort.signal)).rejects.toThrow();expect(readBatchFacts).not.toHaveBeenCalled();
});
