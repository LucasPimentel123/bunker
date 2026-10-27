import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { createPublicClient, createWalletClient, getAddress, http, encodeFunctionData, encodeAbiParameters, parseAbi, concatHex, pad, toHex, zeroAddress, type Address, type Hex, type EIP1193Provider } from 'viem';
import { foundry } from 'viem/chains';
// Only the network catalog and index transport are replaced. Contract inspection,
// permissions, simulation, signing, receipt verification and the UI are production code.
vi.mock('../src/catalog/chains', async () => { const { foundry } = await import('viem/chains'); return { chains: [foundry], chainById: () => foundry }; });
vi.mock('../src/core/ownerHistory', () => ({ discoveryRpc: () => 'http://127.0.0.1:18559' }));
import { readGuidedRecovery, performGuidedRecovery, checkGuidedRecoveryReceipts } from '../src/prototype/guided-recovery';
import { checkExternalAccess } from '../src/prototype/guided-access';
import { inspectAccount } from '../src/core/inspect';
import { safeAbi } from '../src/core/abi';
import { localSafeHash, type SafeHashArgs } from '../src/core/safeHash';
import { contractSignature, encodeAssertion } from '../src/proof/passkey';
import { BUNKER_ORIGIN } from '../src/proof/localBunker';
import { diagnose, verifyOnChain } from '../src/proof/simulation';
import { testKey, testAssertion } from './helpers/passkey';
import { createGuidedWithdrawal } from '../src/prototype/guided-withdrawal';
import type { MigrationItem } from '../src/components/migration';
import { guidedUi } from './helpers/guided-ui';
import safeArtifact from './fixtures/Safe.json';
import proxyArtifact from './fixtures/SafeProxy.json';
import recoveryArtifact from './fixtures/recovery.json';
import passkeyArtifacts from './fixtures/passkey-proof.json';
import proxies from './fixtures/passkey-proxies.json';

const url = 'http://127.0.0.1:18559';
const client = createPublicClient({ chain: foundry, transport: http(url), pollingInterval: 100, cacheTime: 0 });
const wallet = createWalletClient({ chain: foundry, transport: http(url) });
const singleton = '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address;
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)']);
let child: ChildProcess, accounts: Address[], verifier: Address, tokenCode: Hex;
const signal = () => new AbortController().signal;
const raw = (method: string, params: unknown[]) => client.request({ method, params } as never);
async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []) {
  const hash = await wallet.deployContract({ account: accounts[0], abi, bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  if (!receipt.contractAddress) throw Error('Deployment failed');
  return getAddress(receipt.contractAddress);
}
beforeAll(async () => {
  // Never reuse a running chain (or another developer's test session).
  const occupied = await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (occupied) throw Error('Port 18559 is occupied. Stop that local process or choose another test port.');
  child = spawn('anvil', ['--host', '127.0.0.1', '--port', '18559', '--block-time', '1', '--silent'], { stdio: 'pipe' });
  let launchError: Error | undefined;
  child.on('error', error => { launchError = error; });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (launchError || child.exitCode !== null) throw launchError ?? Error('Anvil exited before becoming ready');
    try { accounts = await wallet.getAddresses(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!ready) throw Error('Local Anvil unavailable. Install Foundry/Anvil before running this suite.');
  expect(await client.getChainId()).toBe(31337);
  vi.stubGlobal('location', { origin: BUNKER_ORIGIN });
  vi.stubGlobal('window', { isSecureContext: true });
  await raw('anvil_setCode', [singleton, safeArtifact.deployedBytecode]);
  verifier = await deploy([], passkeyArtifacts.find(v => v.name === 'verifier')!.code as Hex);
  for (const [index, proxy] of proxies.entries()) {
    const factory = await deploy([], passkeyArtifacts.find(v => v.name === (index === 0 ? 'factory020' : 'factory021'))!.code as Hex);
    const signerSingleton = await client.readContract({ address: factory, abi: parseAbi(['function SINGLETON() view returns(address)']), functionName: 'SINGLETON' });
    await raw('anvil_setCode', [proxy.singleton, await client.getCode({ address: signerSingleton })]);
  }
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'TestToken.sol': { content: readFileSync(new URL('./fixtures/TestToken.sol', import.meta.url), 'utf8') } }, settings: { outputSelection: { '*': { '*': ['evm.bytecode'] } } } })));
  tokenCode = `0x${compiled.contracts['TestToken.sol'].TestToken.evm.bytecode.object}`;
}, 60_000);
afterAll(() => { child?.kill('SIGTERM'); vi.unstubAllGlobals(); });

it.each(proxies)('UI → fresh passkey $version Safe → guardian → seven-day wait → new owner → local withdrawal', async proxy => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
  const key = testKey(); // Fresh P256 credential, never a real user's passkey.
  const constructor = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint176' }], [proxy.singleton as Address, BigInt(key.config.x), BigInt(key.config.y), BigInt(verifier)]);
  const signer = await deploy([], concatHex([proxy.creationCode as Hex, constructor]));
  const safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
  const setup = parseAbi(['function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)']);
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe, abi: setup, functionName: 'setup', args: [[signer], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] }) });
  const module = await deploy([], `0x${recoveryArtifact.transactionInput.slice(66)}`);
  const token = await deploy([], tokenCode);
  await raw('anvil_setBalance', [safe, toHex(10n ** 18n)]);
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: token, abi: tokenAbi, functionName: 'mint', args: [safe, 123n] }) });

  const argsFor = (to: Address, data: Hex, value = 0n): SafeHashArgs => [to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress];
  async function passkeySignature(args: SafeHashArgs, credential = key) {
    const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' });
    const hash = localSafeHash(foundry.id, safe, args, nonce);
    const assertion = await encodeAssertion(testAssertion(credential, hash, { origin: BUNKER_ORIGIN }), hash, credential.config, BUNKER_ORIGIN);
    return contractSignature(signer, assertion);
  }
  async function passkeyCall(to: Address, data: Hex) {
    const args = argsFor(to, data), signature = await passkeySignature(args);
    const hash = await wallet.writeContract({ account: accounts[0], address: safe, abi: safeAbi, functionName: 'execTransaction', args: [...args, signature] });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success');
  }
  // Configure the guardian through real Safe transactions signed by the passkey.
  await passkeyCall(safe, encodeFunctionData({ abi: parseAbi(['function enableModule(address)']), functionName: 'enableModule', args: [module] }));
  await passkeyCall(module, encodeFunctionData({ abi: parseAbi(['function addGuardianWithThreshold(address,uint256)']), functionName: 'addGuardianWithThreshold', args: [accounts[1], 1n] }));
  const diagnosis = await diagnose(client, safe, foundry.id);
  expect(diagnosis.snapshot.passkey).toBe('detected');
  expect(diagnosis.snapshot.owners).toEqual([signer]);
  const challenge = toHex(1234n, { size: 32 });
  const assertion = await encodeAssertion(testAssertion(key, challenge, { origin: BUNKER_ORIGIN }), challenge, key.config, BUNKER_ORIGIN);
  await verifyOnChain(client, signer, challenge, assertion, diagnosis.snapshot.block);
  await expect(verifyOnChain(client, signer, toHex(1235n, { size: 32 }), assertion, diagnosis.snapshot.block)).rejects.toThrow();
  const probe = argsFor(accounts[3], '0x', 1n);
  await expect(client.call({ account: accounts[0], to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [...probe, await passkeySignature(probe, testKey())] }) })).rejects.toThrow();

  let active = accounts[1], rejectNextSignature = false, scans = 0;
  const walletEvents = new Map<string, Set<(value: unknown) => void>>();
  const requests: string[] = [];
  const provider = {
    isMetaMask: true,
    on(name: string, fn: (value: unknown) => void) { if (!walletEvents.has(name)) walletEvents.set(name, new Set()); walletEvents.get(name)!.add(fn); },
    removeListener(name: string, fn: (value: unknown) => void) { walletEvents.get(name)?.delete(fn); },
    async request({ method, params }: { method: string; params?: unknown }) {
      requests.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [active];
      // Model the wallet boundary: Anvil has other unlocked test accounts, but
      // this provider must never sign or submit as an account the UI did not connect.
      if (method.startsWith('eth_signTypedData')) expect((params as string[])[0].toLowerCase()).toBe(active.toLowerCase());
      if (method === 'eth_sendTransaction') expect((params as { from: string }[])[0].from.toLowerCase()).toBe(active.toLowerCase());
      if (method.startsWith('eth_signTypedData') && rejectNextSignature) { rejectNextSignature = false; throw Object.assign(Error('User rejected signature'), { code: 4001 }); }
      return client.request({ method, params } as never);
    },
  } as EIP1193Provider;
  const tokenId = `31337:token:${token.toLowerCase()}`, nativeId = '31337:native';
  const items: MigrationItem[] = [
    {id:nativeId,kind:'native',chainId:31337,symbol:'ETH',name:'Ether',order:0,tab:'transfer',selectable:true,amount:{value:10n**18n,decimals:18}},
    {id:tokenId,kind:'token',chainId:31337,symbol:'TEST',name:'Test',order:1,tab:'transfer',selectable:true,holding:{address:token,balance:123n,verifiedDecimals:18,name:'Test',symbol:'TEST'} as MigrationItem['holding']},
  ];
  let loseReceipt = true, rejectPasskey = true;
  const withdrawal = createGuidedWithdrawal(() => items, {
    reader: () => ({...client,waitForTransactionReceipt:async (...args: Parameters<typeof client.waitForTransactionReceipt>)=>{const receipt=await client.waitForTransactionReceipt(...args);if(loseReceipt){loseReceipt=false;throw Error('Lost receipt response');}return receipt;}}),
    identity: () => ({key:key.config,credentialId:'test',assertCurrent:()=>{}}),
    authorize: async (_identity,hash) => {if(rejectPasskey){rejectPasskey=false;throw Error('Passkey rejected');}return {owner:signer,signature:contractSignature(signer,await encodeAssertion(testAssertion(key,hash,{origin:BUNKER_ORIGIN}),hash,key.config,BUNKER_ORIGIN))};},
  });
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body=JSON.parse(init.body as string);
    expect(['eth_chainId','eth_getBalance']).toContain(body.method);
    return {ok:true,json:async()=>({id:1,jsonrpc:'2.0',result:await client.request({method:body.method,params:body.params})})};
  }) as typeof fetch;
  // A real signature and Safe execution, with only the device prompt replaced
  // by a fresh software WebAuthn assertion. No discovery signature is reused.
  const passkeyRequest={account:safe,chainId:31337,payer:active,destination:active,method:'passkey' as const,ids:[tokenId]};
  const passkeyPlan=await withdrawal.prepare(passkeyRequest,signal());expect(passkeyPlan.status).toBe('ready');
  if(passkeyPlan.status!=='ready')throw Error('Missing passkey withdrawal');
  const sendsBeforePasskey=requests.filter(m=>m==='eth_sendTransaction').length;
  await expect(withdrawal.execute(passkeyPlan.id,provider,signal(),()=>{})).rejects.toThrow('Passkey rejected');
  expect(requests.filter(m=>m==='eth_sendTransaction')).toHaveLength(sendsBeforePasskey);
  const retryPlan=await withdrawal.prepare(passkeyRequest,signal());if(retryPlan.status!=='ready')throw Error('No retry plan');
  await expect(withdrawal.execute(retryPlan.id,provider,signal(),()=>{})).rejects.toMatchObject({pendingHash:expect.stringMatching(/^0x/)});
  const resumed=createGuidedWithdrawal(()=>items,{reader:()=>client});
  expect((await resumed.prepare(passkeyRequest,signal())).status).toBe('pending');
  expect((await resumed.receipt(safe,31337,signal())).completed).toEqual([tokenId]);
  expect(requests.filter(m=>m==='eth_sendTransaction')).toHaveLength(sendsBeforePasskey+1);
  expect(await client.readContract({address:token,abi:tokenAbi,functionName:'balanceOf',args:[active]})).toBe(123n);
  await client.waitForTransactionReceipt({hash:await wallet.writeContract({account:accounts[0],address:token,abi:tokenAbi,functionName:'mint',args:[safe,123n]})});
  const discovery = {
    withdrawal,
    discover: async () => ({ addresses: [safe], issues: [] }), // Index hint; all authority is verified on-chain.
    checkAccess: checkExternalAccess,
    recovery: { read: readGuidedRecovery, perform: performGuidedRecovery, receipts: checkGuidedRecoveryReceipts },
    scan: async (account: Address, abort: AbortSignal) => {
      scans++;
      expect((await checkExternalAccess(account, active, abort)).ready).toBe(true);
      const balance = await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [account] });
      return { account, checkedAt: new Date().toISOString(), networks: [{ id: '31337', chainId: 31337, name: 'Foundry', symbol: 'ETH', status: 'complete', items: [{id:tokenId,name:'TEST',balance:balance.toString(),selectable:true},{id:nativeId,name:'ETH',balance:'1',selectable:true}] }] };
    },
  };
  let ui = guidedUi(discovery, provider, fetcher);
  const idle = () => !ui.state.busy && !ui.state.recoverySending;
  const screen = async (name: string) => ui.waitFor(() => ui.state.screen === name && idle());
  async function connect() {
    const id = ui.html.match(/data-source-provider="([^"]+)"/)?.[1];
    if (!id) throw Error('No wallet option rendered');
    await ui.click('source-provider', id);
  }
  async function action() {
    await ui.click('action', 'recovery-act');
    expect(ui.html).toContain('role="progressbar"');
    await ui.waitFor(idle);
    expect(ui.state.error).toBe('');
  }
  try {
    await ui.click('method', 'wallet'); await connect(); await screen('recover-access');
    expect(scans).toBe(0); expect(ui.html).toContain('Você tem a passkey?');
    await ui.click('action', 'no-passkey'); await screen('recovery-owner');
    for (const forbidden of [accounts[1], safe, zeroAddress]) {
      ui.owner(forbidden);
      await expect(ui.click('action', 'next')).rejects.toThrow(/disabled/);
      await expect(performGuidedRecovery(safe, accounts[1], forbidden, 31337, module, 'approve', provider, signal(), () => {})).rejects.toThrow(/novo owner/);
    }
    // A funded Safe does not substitute for gas in the sending guardian wallet.
    const guardianGas = await client.getBalance({ address: accounts[1] });
    await raw('anvil_setBalance', [accounts[1], '0x0']);
    try {
      expect((await readGuidedRecovery(safe, accounts[1], accounts[2], signal())).networks[0].modules[0].operation).toBeUndefined();
      await expect(performGuidedRecovery(safe, accounts[1], accounts[2], 31337, module, 'approve', provider, signal(), () => {})).rejects.toThrow(/autorizada/);
    } finally { await raw('anvil_setBalance', [accounts[1], toHex(guardianGas)]); }
    ui.owner(accounts[2]); await ui.click('action', 'next'); await screen('recovery-network');
    expect(ui.html).toContain('<strong>7 dias</strong>');
    expect(ui.html).not.toContain('Detalhes da recuperação');
    expect(ui.html).toContain(accounts[2]);
    // Denial must not broadcast or falsely advance; retry stays possible.
    const sentBefore = requests.filter(v => v === 'eth_sendTransaction').length;
    rejectNextSignature = true;
    await ui.click('action', 'recovery-act'); await ui.waitFor(idle);
    expect(ui.state.error).not.toBe('');
    expect(requests.filter(v => v === 'eth_sendTransaction')).toHaveLength(sentBefore);
    expect(ui.state.recovery.networks[0].modules[0].operation).toBe('approve');
    await action(); expect(ui.state.recovery.networks[0].modules[0].operation).toBe('start');
    await action(); expect(ui.html).toContain('O prazo já começou');
    expect(ui.html).not.toContain('data-action="recovery-act"');
    expect(scans).toBe(0);
    // Lose all controller memory, as on page reload. The pending target and delay
    // must be rediscovered from the chain without signing the approval again.
    const signaturesBeforeReload = requests.filter(v => v.startsWith('eth_signTypedData')).length;
    ui.dispose(); ui = guidedUi(discovery, provider, fetcher);
    await ui.click('method', 'wallet'); await connect(); await screen('recover-access');
    await ui.click('action', 'no-passkey'); await screen('recovery-network');
    expect(ui.state.recoveryOwner.toLowerCase()).toBe(accounts[2].toLowerCase());
    expect(ui.html).toContain('O prazo já começou');
    expect(requests.filter(v => v.startsWith('eth_signTypedData'))).toHaveLength(signaturesBeforeReload);
    await expect(performGuidedRecovery(safe, accounts[1], accounts[2], 31337, module, 'finalize', provider, signal(), () => {})).rejects.toThrow(/autorizada/);
    // Contract also enforces the delay, independently of UI/app permissions.
    await expect(client.simulateContract({ account: accounts[1], address: module, abi: parseAbi(['function finalizeRecovery(address)']), functionName: 'finalizeRecovery', args: [safe] })).rejects.toThrow();
    await raw('evm_increaseTime', [604801]); await raw('evm_mine', []);
    // The shipped UI polls automatically; exercise the same scheduled refresh.
    await ui.waitFor(() => ui.state.recovery.networks[0].modules[0].operation === 'finalize' && idle(), 40_000);
    await action(); expect(ui.html).toContain('Acesso recuperado');
    const result = await inspectAccount(client, safe, 31337);
    expect(result.owners).toEqual([accounts[2]]); expect(result.threshold).toBe(1n);
    expect(result.recoveries[0].pending.executeAfter).toBe(0n);
    expect((await readGuidedRecovery(safe, accounts[1], accounts[2], signal())).pending).toEqual([]);
    // Old passkey cannot execute after ownership has changed, even when valid.
    await expect(client.call({ account: accounts[0], to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [...probe, await passkeySignature(probe)] }) })).rejects.toThrow();
    await ui.click('action', 'change-source'); active = accounts[2]; await connect(); await screen('assets');
    expect(scans).toBe(1); expect(ui.html).toContain(safe); expect(ui.html).toContain('TEST');
    const recipientBefore = await client.getBalance({ address: accounts[3] });
    await expect(withdrawal.prepare({account:safe,chainId:31337,payer:accounts[1],destination:accounts[3],method:'wallet',ids:[tokenId]},signal())).rejects.toThrow(/não controla/);
    await ui.click('action','next');await screen('fees');await ui.click('action','next');await screen('destination');
    ui.destination(accounts[3]);await ui.click('action','next');await screen('move');expect(ui.state.withdrawal.status).toBe('ready');
    for(let part=0;part<2;part++) {
      await ui.click('action','next');await ui.waitFor(()=>idle()&&ui.state.withdrawal?.status==='confirmed');
      expect(ui.state.error).toBe('');
      await ui.click('action','next');await screen('move');
    }
    expect(ui.state.withdrawal.status).toBe('empty');await ui.click('action','next');await screen('done');
    expect(ui.state.withdrawalReceipts).toHaveLength(2);
    expect(await client.getBalance({ address: safe })).toBe(0n);
    expect(await client.getBalance({ address: accounts[3] })).toBe(recipientBefore + 10n ** 18n);
    expect(await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [accounts[3]] })).toBe(123n);
    expect(await client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [safe] })).toBe(0n);
  } finally { ui.dispose(); }
}, 180_000);
