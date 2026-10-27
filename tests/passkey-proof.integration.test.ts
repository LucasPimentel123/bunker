import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, http, concatHex, encodeAbiParameters, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { readFileSync } from "node:fs";
import solc from "solc";
import multiSendArtifact from "./fixtures/MultiSendCallOnly.json";
import { batchPartAction, planBatch, readBatchFacts } from "../src/core/batch";
import safeArtifact from "./fixtures/Safe.json";
import proxyArtifact from "./fixtures/SafeProxy.json";
import proxies from "./fixtures/passkey-proxies.json";
import artifacts from "./fixtures/passkey-proof.json";
import { localSafeHash, type SafeHashArgs } from "../src/core/safeHash";
import { safeAbi } from "../src/core/abi";
import { diagnose, prepareActionSimulation, simulateAction, prepareSimulation, simulateWithdrawal, verifyOnChain } from "../src/proof/simulation";
import { encodeAssertion, PROOF_ORIGIN } from "../src/proof/passkey";
import { BUNKER_ORIGIN } from "../src/proof/localBunker";
import { EXTENSION_ORIGIN } from "../src/extension/context";
import { identifyPasskey, predictPasskeySigners } from "../src/proof/passkeyDiscovery";
import { discoverCandidateAccounts, startDiscovery, resolveDiscovery, keyId } from "../src/proof/discoveryFlow";
import factories from "../src/catalog/passkey-factories.json";
import { testKey, testAssertion } from "./helpers/passkey";
const proofChain = { ...foundry, id: 100 };
const publicClient = createPublicClient({ chain: proofChain, transport: http("http://127.0.0.1:18549"), cacheTime: 0, ccipRead: false });
const wallet = createWalletClient({ chain: proofChain, transport: http("http://127.0.0.1:18549") });
let child: ChildProcess, accounts: Address[], verifier: Address, token: Address;
const MS141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as const;
const singleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const keys = testKey();
async function raw(method: string, params: unknown[]) { return publicClient.request({ method, params } as never); }
async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: accounts[0], abi, bytecode, args }) });
  if (!receipt.contractAddress) throw new Error("Deployment failed");
  return receipt.contractAddress;
}
beforeAll(async () => {
  child = spawn("anvil", ["--port", "18549", "--chain-id", "100", "--silent"], { stdio: "pipe" });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("Anvil could not start");
    try { accounts = await wallet.getAddresses(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!ready) throw new Error("Anvil unavailable");
  await raw("anvil_setCode", [singleton, safeArtifact.deployedBytecode]);
  await raw("anvil_setCode", [MS141, multiSendArtifact.deployedBytecode]);
  const input = { language: "Solidity", sources: { "TestToken.sol": { content: readFileSync(new URL("./fixtures/TestToken.sol", import.meta.url), "utf8") } }, settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } };
  const compiled = JSON.parse(solc.compile(JSON.stringify(input))).contracts["TestToken.sol"].TestToken;
  token = await deploy(compiled.abi, `0x${compiled.evm.bytecode.object}`);
  for (const fixture of artifacts) expect(keccak256(fixture.code as Hex)).toBe(fixture.creationHash);
  verifier = await deploy([], artifacts.find(v => v.name === "verifier")!.code as Hex);
  for (const [index, proxy] of proxies.entries()) {
    const factory = await deploy([], artifacts.find(v => v.name === (index === 0 ? "factory020" : "factory021"))!.code as Hex);
    const signerSingleton = await publicClient.readContract({ address: factory, abi: parseAbi(["function SINGLETON() view returns(address)"]), functionName: "SINGLETON" });
    const code = await publicClient.getCode({ address: signerSingleton });
    await raw("anvil_setCode", [proxy.singleton, code]);
  }
}, 60_000);
afterAll(() => child?.kill("SIGTERM"));
describe("Real Safe + WebAuthn + P256 verifier bytecode", () => {
  it.each(proxies.flatMap(proxy => [PROOF_ORIGIN, EXTENSION_ORIGIN, BUNKER_ORIGIN].map(origin => ({ ...proxy, origin }))))("validates and simulates a native withdrawal with WebAuthn $version from $origin", async proxy => {
    const constructor = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }], [proxy.singleton as Address, BigInt(keys.config.x), BigInt(keys.config.y), BigInt(verifier)]);
    const signer = await deploy([], concatHex([proxy.creationCode as Hex, constructor]));
    const safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe,
      abi: parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]), functionName: "setup", args: [[signer], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }) });
    await raw("anvil_setBalance", [safe, toHex(10n ** 18n)]);
    const diagnosis = await diagnose(publicClient, safe, proofChain.id);
    expect(diagnosis.signers[0].x).toBe(keys.config.x);
    expect(diagnosis.signers[0].y).toBe(keys.config.y);
    const beforeBalance = await publicClient.getBalance({ address: safe });
    const beforeRecipient = await publicClient.getBalance({ address: accounts[2] });
    const challenge = toHex(7n, { size: 32 });
    const signature = await encodeAssertion(testAssertion(keys, challenge, { origin: proxy.origin }), challenge, diagnosis.signers[0], proxy.origin);
    await verifyOnChain(publicClient, signer, challenge, signature, diagnosis.snapshot.block);
    await expect(verifyOnChain(publicClient, signer, toHex(8n, { size: 32 }), signature, diagnosis.snapshot.block)).rejects.toThrow();
    const plan = await prepareSimulation(publicClient, diagnosis, signer, { payer: accounts[1], recipient: accounts[2], amount: 1_000_000n });
    // The contract is an independent test oracle, never a source of signing bytes.
    const oracle = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...plan.args, plan.nonce] });
    expect(plan.challenge).toBe(oracle);
    const nonzeroArgs: SafeHashArgs = [accounts[2], 42n, "0xaabbcc0011223344", 1, 123n, 456n, 789n, accounts[3], accounts[4]];
    expect(localSafeHash(proofChain.id, safe, nonzeroArgs, 13n)).toBe(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...nonzeroArgs, 13n] }));
    const txSignature = await encodeAssertion(testAssertion(keys, plan.challenge, { origin: proxy.origin }), plan.challenge, diagnosis.signers[0], proxy.origin);
    expect(await simulateWithdrawal(publicClient, plan, txSignature)).toMatchObject({ result: "safe-execution-simulated", broadcast: false, nonceOverrideOnly: true });
    expect(await publicClient.getBalance({ address: safe })).toBe(beforeBalance);
    expect(await publicClient.getBalance({ address: accounts[2] })).toBe(beforeRecipient);
    expect(await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" })).toBe(0n);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: token, abi: parseAbi(["function mint(address to,uint256 amount)"]), functionName: "mint", args: [safe, 100n] }) });
    const batchDiagnosis = await diagnose(publicClient, safe, proofChain.id);
    const sources = [{ id: "native", kind: "native" as const, label: "native" }, { id: "token", kind: "token" as const, token, label: "TEST" }];
    const facts = await readBatchFacts(publicClient, batchDiagnosis.snapshot, sources);
    const batch = planBatch({ snapshot: batchDiagnosis.snapshot, destination: accounts[2], facts, multisend: MS141 });
    const action = batchPartAction({ snapshot: batchDiagnosis.snapshot, plan: batch, part: 0, label: "Native + ERC20", reread: () => readBatchFacts(publicClient, batchDiagnosis.snapshot, sources) });
    const batchSimulation = await prepareActionSimulation(publicClient, batchDiagnosis, signer, action, accounts[1]);
    expect(batchSimulation.args[3]).toBe(1);
    const batchSignature = await encodeAssertion(testAssertion(keys, batchSimulation.challenge, { origin: proxy.origin }), batchSimulation.challenge, keys.config, proxy.origin);
    expect(await simulateAction(publicClient, batchSimulation, batchSignature)).toMatchObject({ broadcast: false, safe: batchDiagnosis.snapshot.address });
    expect(await publicClient.getBalance({ address: safe })).toBe(beforeBalance);
    expect(await publicClient.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns(uint256)"]), functionName: "balanceOf", args: [safe] })).toBe(100n);
    await expect(prepareActionSimulation(publicClient, batchDiagnosis, signer, { ...action, forbiddenRecipients: [accounts[2]] }, accounts[1])).rejects.toThrow(/guardian/);
    await expect(simulateAction(publicClient, { ...batchSimulation, challenge: toHex(999n, { size: 32 }) }, batchSignature)).rejects.toThrow(/hash/);

    // Same signature cannot execute against the real current nonce.
    const { encodeFunctionData } = await import("viem");
    const { contractSignature } = await import("../src/proof/passkey");
    await expect(publicClient.call({ account: accounts[1], to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...plan.args, contractSignature(signer, txSignature)] }) })).rejects.toThrow();
    const other = testKey();
    const wrong = await encodeAssertion(testAssertion(other, plan.challenge, { origin: proxy.origin }), plan.challenge, other.config, proxy.origin);
    await expect(simulateWithdrawal(publicClient, plan, wrong)).rejects.toThrow();
    await expect(prepareSimulation(publicClient, diagnosis, signer, { payer: accounts[1], recipient: accounts[2], amount: 10n ** 20n })).rejects.toThrow(/saldo/);
    const canonicalCode = await publicClient.getCode({ address: proxy.singleton as Address });
    await raw("anvil_setCode", [proxy.singleton, "0x60006000f3"]);
    try { await expect(diagnose(publicClient, safe, proofChain.id)).rejects.toThrow(/bytecode verificado/); }
    finally { await raw("anvil_setCode", [proxy.singleton, canonicalCode]); }
  }, 60_000);
});


describe("passkey-first discovery with real contract verification", () => {
  it.each(["0.2.0", "0.2.1"])("finds the Safe from one assertion with no supplied Safe address (%s)", async version => {
    const first = { credentialId: "AQID", challenge: toHex(101n, { size: 32 }), assertion: testAssertion(keys, toHex(101n, { size: 32 }), { origin: EXTENSION_ORIGIN }) };
    const session = startDiscovery(first, EXTENSION_ORIGIN);
    const recovered = { x: keys.config.x, y: keys.config.y };
    const candidate = predictPasskeySigners(recovered).find(value => value.version === version)!;
    const factory = factories.find(value => value.version === version)!;
    const verifierCode = await publicClient.getCode({ address: verifier });
    await raw("anvil_setCode", [factory.verifiers[0], verifierCode]);
    const constructor = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(factory.singleton), BigInt(recovered.x), BigInt(recovered.y), candidate.verifiers]);
    const temporarySigner = await deploy([], concatHex([factory.creationCode as Hex, constructor]));
    const code = await publicClient.getCode({ address: temporarySigner });
    await raw("anvil_setCode", [candidate.address, code]);
    const safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe,
      abi: parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]), functionName: "setup", args: [[candidate.address], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }) });
    const requested: string[] = [];
    const lookup = async (_chainId: number, signer: Address) => { requested.push(signer); return { addresses: [accounts[2], safe, safe], incomplete: false }; };
    const result = await discoverCandidateAccounts(publicClient, proofChain.id, session, EXTENSION_ORIGIN, lookup);
    expect(resolveDiscovery(session, [result])).toMatchObject({ key: recovered, needsSecondAssertion: false });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].diagnosis.snapshot.address.toLowerCase()).toBe(safe.toLowerCase());
    expect(result.accounts[0].signer).toBe(candidate.address);
    expect(result.issues.some(issue => issue.includes(accounts[2]))).toBe(true);
    expect(requested).toContain(candidate.address);
    // A compromised provider/index cannot substitute an arbitrary signer runtime.
    await raw("anvil_setCode", [candidate.address, "0x60006000f3"]);
    requested.length = 0;
    const rejected = await discoverCandidateAccounts(publicClient, proofChain.id, session, EXTENSION_ORIGIN, lookup);
    expect(rejected.accounts).toHaveLength(0);
    expect(requested).not.toContain(candidate.address);
    expect(rejected.issues.some(issue => issue.includes("não reconhecido"))).toBe(true);
    await raw("anvil_setCode", [candidate.address, "0x"]);
  }, 60_000);
});

it("requests a second assertion only after distinct candidates have verified deployed Safes", async () => {
  const key = testKey();
  const challenge = toHex(201n, { size: 32 });
  const proof = { credentialId: "AQID", challenge, assertion: testAssertion(key, challenge, { origin: BUNKER_ORIGIN }) };
  const session = startDiscovery(proof, BUNKER_ORIGIN);
  expect(session.candidates.length).toBeGreaterThan(1);
  const realKey = { x: key.config.x, y: key.config.y };
  const otherKey = session.candidates.find(candidate => keyId(candidate) !== keyId(realKey))!;
  const hints = new Map<string, Address[]>();
  const lookup = async (_id: number, signer: Address) => ({ addresses: hints.get(signer) ?? [], incomplete: false });
  const scan = () => discoverCandidateAccounts(publicClient, proofChain.id, session, BUNKER_ORIGIN, lookup);
  const factory = factories.find(value => value.version === "0.2.1")!;
  await raw("anvil_setCode", [factory.verifiers[0], await publicClient.getCode({ address: verifier })]);
  async function deploySigner(coordinates: typeof realKey) {
    const candidate = predictPasskeySigners(coordinates).find(value => value.version === "0.2.1")!;
    const constructor = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(factory.singleton), BigInt(coordinates.x), BigInt(coordinates.y), candidate.verifiers]);
    const temporary = await deploy([], concatHex([factory.creationCode as Hex, constructor]));
    await raw("anvil_setCode", [candidate.address, await publicClient.getCode({ address: temporary })]);
    return candidate.address;
  }
  async function deploySafe(owner: Address) {
    const safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe,
      abi: parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]), functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }) });
    hints.set(owner, [...(hints.get(owner) ?? []), safe]);
    return safe;
  }
  expect(resolveDiscovery(session, [await scan()]).needsSecondAssertion).toBe(false);
  const realSigner = await deploySigner(realKey), otherSigner = await deploySigner(otherKey);
  // Signer deployments alone, index failures and invented/EOA hints do not count.
  hints.set(otherSigner, [accounts[2]]);
  const noSafes = await scan();
  expect(noSafes.accounts).toHaveLength(0);
  expect(resolveDiscovery(session, [noSafes]).needsSecondAssertion).toBe(false);
  const failed = await discoverCandidateAccounts(publicClient, proofChain.id, session, BUNKER_ORIGIN, async () => { throw new Error("HTTP 429"); });
  expect(failed.issues).toContain("HTTP 429");
  expect(resolveDiscovery(session, [failed]).needsSecondAssertion).toBe(false);
  const safe1 = await deploySafe(realSigner), safe2 = await deploySafe(realSigner);
  const oneKey = await scan();
  expect(oneKey.accounts).toHaveLength(2);
  expect(resolveDiscovery(session, [oneKey, { ...oneKey, chainId: 137 }])).toMatchObject({ key: realKey, needsSecondAssertion: false });
  // Now deploy a real Safe for the alternate recovered key: same first signature
  // is mathematically valid for both. This must block account selection.
  await deploySafe(otherSigner);
  const ambiguous = await scan();
  expect(ambiguous.accounts).toHaveLength(3);
  expect(resolveDiscovery(session, [ambiguous])).toMatchObject({ key: undefined, needsSecondAssertion: true });
  const secondChallenge = toHex(202n, { size: 32 });
  const second = { credentialId: "AQID", challenge: secondChallenge, assertion: testAssertion(key, secondChallenge, { origin: BUNKER_ORIGIN }) };
  const confirmedKey = await identifyPasskey(proof, second, BUNKER_ORIGIN);
  const confirmedSession = { ...session, confirmedKey, proof: second };
  const resolved = await discoverCandidateAccounts(publicClient, proofChain.id, confirmedSession, BUNKER_ORIGIN, lookup);
  expect(resolveDiscovery(confirmedSession, [resolved])).toMatchObject({ key: realKey, needsSecondAssertion: false });
  expect(resolved.accounts.map(account => account.diagnosis.snapshot.address.toLowerCase()).sort()).toEqual([safe1, safe2].map(a => a.toLowerCase()).sort());
}, 60_000);
