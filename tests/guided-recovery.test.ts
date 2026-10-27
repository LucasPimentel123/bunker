import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { zeroAddress, type Address, type EIP1193Provider } from 'viem';
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn(), send: vi.fn(), receipt: vi.fn(), block: vi.fn() }));
vi.mock('../src/prototype/guided-access', () => ({ checkExternalAccess: mocks.access }));
vi.mock('../src/core/client', async original => ({ ...await original<typeof import('../src/core/client')>(), publicClient: () => ({ getTransactionReceipt: mocks.receipt, getBlockNumber: mocks.block }) }));
vi.mock('../src/core/recoveryPreparation', async original => ({ ...await original<typeof import('../src/core/recoveryPreparation')>(), readRecoveryPreparation: mocks.read }));
vi.mock('../src/core/actions', async original => ({ ...await original<typeof import('../src/core/actions')>(), sendAction: mocks.send }));
import { readGuidedRecovery, performGuidedRecovery, checkGuidedRecoveryReceipts } from '../src/prototype/guided-recovery';
import type { AccountSnapshot } from '../src/core/types';
const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const owner = '0xcccccccccccccccccccccccccccccccccccccccc' as Address;
const module = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const oldOwner = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;
const hash = `0x${'1'.repeat(64)}`;
const provider = {} as EIP1193Provider;
let snapshot: AccountSnapshot, data: { snapshot: AccountSnapshot; gas: bigint; approvals: Record<string, { count: bigint; approved: boolean }> };
let store: Map<string,string>;
const signal = () => new AbortController().signal;
beforeEach(() => {
 vi.clearAllMocks();
 vi.stubGlobal('location', { origin: 'https://bunker.usepicnic.com:8443' });vi.stubGlobal('window', { isSecureContext: true });
 store = new Map();vi.stubGlobal('localStorage', { getItem: (k:string) => store.get(k) ?? null, setItem: (k:string,v:string) => store.set(k,v) });
 snapshot = { address: safe, chainId: 137, version: '1.4.1', owners: [oldOwner], threshold: 1n, block: 1n, timestamp: 100n, nonce: 1n, modules: [module], guard: zeroAddress, moduleGuard: zeroAddress, nativeBalance: 1n, warnings: [], passkey: 'detected', recoveries: [{ module, runtimeHash:'0x', supported:true, threshold:1n, nonce:0n, guardians:[wallet], period:604800n, pending:{executeAfter:0n,newOwners:[],newThreshold:0n,guardiansApprovalCount:0n} }] };
 data = { snapshot, gas: 1n, approvals: { [module]: { count: 0n, approved: false } } };
 mocks.access.mockImplementation(async()=>({ networks:[{chainId:137,name:'Polygon',status:'guardian',snapshot}] }));
 mocks.read.mockImplementation(async()=>data);
 mocks.send.mockImplementation(async(_reader,_provider,_action,hooks)=>{hooks.onSigning('signature');hooks.onSubmitted(hash);return {transactionHash:hash};});
 mocks.receipt.mockResolvedValue({status:'success',logs:[],blockNumber:1n});mocks.block.mockResolvedValue(2n);
});
afterEach(()=>vi.unstubAllGlobals());
describe('guided real guardian recovery',()=>{
 it('derives approve/start/wait/finalize from fresh on-chain permissions',async()=>{
  expect((await readGuidedRecovery(safe,wallet,owner,signal())).networks[0].modules[0].operation).toBe('approve');
  data.approvals[module]={count:1n,approved:true};
  expect((await readGuidedRecovery(safe,wallet,owner,signal())).networks[0].modules[0].operation).toBe('start');
  snapshot.recoveries[0].pending={executeAfter:200n,newOwners:[owner],newThreshold:1n,guardiansApprovalCount:1n};
  expect((await readGuidedRecovery(safe,wallet,owner,signal())).networks[0].modules[0].operation).toBeUndefined();
  snapshot.timestamp=201n;
  expect((await readGuidedRecovery(safe,wallet,owner,signal())).networks[0].modules[0].operation).toBe('finalize');
 });
 it('uses existing action builder and sender with bound wallet, target and guardians',async()=>{
  const progress=vi.fn();await performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),progress);
  expect(mocks.send).toHaveBeenCalledOnce();const action=mocks.send.mock.calls[0][2];
  expect(action.expectedSender.toLowerCase()).toBe(wallet);expect(action.expectedOwner.toLowerCase()).toBe(owner);expect(action.approval.owner.toLowerCase()).toBe(owner);
  expect(action.forbiddenRecipients).toContain(wallet);expect((await readGuidedRecovery(safe,wallet,owner,signal())).pending).toEqual([]);expect(progress).toHaveBeenCalledWith('Assine a autorização de recuperação na carteira.');
 });
 it('blocks all guardians, connected wallet and Safe before any signature, including finalization',async()=>{
  snapshot.recoveries[0].guardians=[wallet,owner];
  for(const target of [wallet,owner,safe])await expect(performGuidedRecovery(safe,wallet,target,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/novo owner/);
  snapshot.recoveries[0].pending={executeAfter:50n,newOwners:[owner],newThreshold:1n,guardiansApprovalCount:1n};
  await expect(performGuidedRecovery(safe,wallet,owner,137,module,'finalize',provider,signal(),vi.fn())).rejects.toThrow(/novo owner/);expect(mocks.send).not.toHaveBeenCalled();
 });
 it('blocks incomplete checks, zero gas and approvals that are not sufficient',async()=>{
  mocks.access.mockResolvedValueOnce({networks:[{chainId:137,name:'Polygon',status:'unknown'}]});
  await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/conferir todas/);
  data.gas=0n;await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/autorizada/);
  data.gas=1n;await expect(performGuidedRecovery(safe,wallet,owner,137,module,'start',provider,signal(),vi.fn())).rejects.toThrow(/autorizada/);expect(mocks.send).not.toHaveBeenCalled();
 });
 it('persists submitted hashes and prevents resubmission until two confirmations',async()=>{
  mocks.send.mockImplementationOnce(async(_r,_p,_a,hooks)=>{hooks.onSubmitted(hash);throw Error('timeout');});
  await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow('timeout');
  expect((await readGuidedRecovery(safe,wallet,owner,signal())).pending[0].hash).toBe(hash);
  await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/transação enviada/);expect(mocks.send).toHaveBeenCalledOnce();
  mocks.block.mockResolvedValueOnce(1n);await expect(checkGuidedRecoveryReceipts(safe,signal())).rejects.toThrow(/confirmações/);
  await checkGuidedRecoveryReceipts(safe,signal());expect((await readGuidedRecovery(safe,wallet,owner,signal())).pending).toEqual([]);
 });
 it('rejects an untrusted origin and unavailable journal before asking the wallet',async()=>{
  vi.stubGlobal('location',{origin:'https://example.test'});await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/Bunker local/);
  vi.stubGlobal('location',{origin:'https://bunker.usepicnic.com:8443'});vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw Error('storage unavailable');}});
  await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn())).rejects.toThrow(/storage/);expect(mocks.send).not.toHaveBeenCalled();
 });
});

it('explicitly skipping an unavailable network permits only verified networks and never a skipped target',async()=>{
 mocks.access.mockImplementation(async()=>({networks:[{chainId:137,name:'Polygon',status:'guardian',snapshot},{chainId:999,name:'HyperEVM',status:'unknown'}]}));
 expect((await readGuidedRecovery(safe,wallet,owner,signal())).complete).toBe(false);
 const scoped=await readGuidedRecovery(safe,wallet,owner,signal(),[999]);expect(scoped.complete).toBe(true);expect(scoped.networks.map(n=>n.chainId)).toEqual([137]);
 await performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn(),[999]);expect(mocks.send).toHaveBeenCalledOnce();
 await expect(performGuidedRecovery(safe,wallet,owner,999,module,'approve',provider,signal(),vi.fn(),[999])).rejects.toThrow(/deixada para depois/);expect(mocks.send).toHaveBeenCalledOnce();
});
it('excluding a network never removes its known guardians from the owner exclusion',async()=>{
 const other={...snapshot,chainId:100,recoveries:[{...snapshot.recoveries[0],guardians:[owner]}]};
 mocks.access.mockImplementation(async()=>({networks:[{chainId:137,name:'Polygon',status:'guardian',snapshot},{chainId:100,name:'Gnosis',status:'guardian',snapshot:other}]}));
 await expect(performGuidedRecovery(safe,wallet,owner,137,module,'approve',provider,signal(),vi.fn(),[100])).rejects.toThrow(/novo owner/);expect(mocks.send).not.toHaveBeenCalled();
});
