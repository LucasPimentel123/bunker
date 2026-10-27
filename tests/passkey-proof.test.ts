import { describe, expect, it, vi } from "vitest";
import { concatHex, encodeAbiParameters, toHex, zeroAddress, type Hex, type PublicClient } from "viem";
import { base64url, contractSignature, credentialBytes, decodeDer, encodeAssertion, importMetadata, signerConfiguration } from "../src/proof/passkey";
import { testKey, testAssertion } from "./helpers/passkey";
import { localSafeHash, type SafeHashArgs } from "../src/core/safeHash";
import { safeHash } from "../src/core/actions";
import { prepareSimulation, simulateWithdrawal, simulationChallenge, type Diagnosis } from "../src/proof/simulation";
import signers from "../src/catalog/passkey-signers.json";
const challenge = toHex(42n, { size: 32 });
describe("Local passkey proof", () => {
  it("validates actual P-256 assertions against the key recovered on-chain", async () => {
    const key = testKey();
    const encoded = await encodeAssertion(testAssertion(key, challenge), challenge, key.config);
    expect(encoded.length).toBeGreaterThan(300);
    await expect(encodeAssertion(testAssertion(testKey(), challenge), challenge, key.config)).rejects.toThrow(/não corresponde/);
    await expect(encodeAssertion(testAssertion(key, challenge), toHex(43n, { size: 32 }), key.config)).rejects.toThrow(/Challenge/);
  });
  it.each([{ origin: "https://usepicnic.com" }, { flags: 1 }, { flags: 4 }, { rpId: "attacker.com" }, { crossOrigin: true }])("rejects incorrect ceremony context %j", async (options) => {
    const key = testKey();
    await expect(encodeAssertion(testAssertion(key, challenge, options), challenge, key.config)).rejects.toThrow();
  });
  it("rejects modified signed bytes", async () => {
    const key = testKey(), assertion = testAssertion(key, challenge);
    assertion.authenticatorData[36] ^= 1;
    await expect(encodeAssertion(assertion, challenge, key.config)).rejects.toThrow(/não corresponde/);
  });
  it.each(["3006020100020101", "3006020180020101", "300702020001020101", "300602010102010100", "308106020101020101"])("rejects malformed/noncanonical DER %s", value => {
    expect(() => decodeDer(Buffer.from(value, "hex"))).toThrow();
  });
  it("accepts only bounded public credential metadata", () => {
    const metadata = { version: 1, rpId: "usepicnic.com", credentialId: base64url(new Uint8Array([1, 2, 3])) };
    expect(importMetadata(JSON.stringify(metadata))).toEqual(metadata);
    for (const extra of [{ privateKey: "never-import" }, { rpc: "https://attacker" }, { rpId: "localhost" }, { credentialId: "@@" }, { credentialId: "AQ==" }]) expect(() => importMetadata(JSON.stringify({ ...metadata, ...extra }))).toThrow();
    expect(() => importMetadata(" ".repeat(4097))).toThrow();
    expect(credentialBytes(metadata.credentialId)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("decodes constructor immutables for both Picnic signer versions", () => {
    for (const signer of signers) {
      let runtime = signer.runtime;
      for (const [index, value] of [3n, 2n, 1n, BigInt(signer.singleton)].entries()) {
        const at = 2 + signer.immutableSlots[index] * 2;
        runtime = runtime.slice(0, at) + toHex(value, { size: 32 }).slice(2) + runtime.slice(at + 64);
      }
      expect(signerConfiguration(runtime as Hex)).toMatchObject({ x: toHex(1n, { size: 32 }), y: toHex(2n, { size: 32 }), verifiers: toHex(3n, { size: 32 }) });
    }
  });
  it("encodes Safe's dynamic ERC1271 contract-signature offset", () => {
    const signer = "0x0000000000000000000000000000000000001234";
    expect(contractSignature(signer, "0xaabb")).toBe(concatHex([encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [signer, 65n]), "0x00", toHex(2, { size: 32 }), "0xaabb"]));
  });
});


describe("signing hash cannot be supplied by an RPC", () => {
  const safe = "0x1111111111111111111111111111111111111111" as const;
  const signer = "0x2222222222222222222222222222222222222222" as const;
  const recipient = "0x3333333333333333333333333333333333333333" as const;
  const payer = "0x4444444444444444444444444444444444444444" as const;
  const config = testKey().config;
  const diagnosis: Diagnosis = { snapshot: { address: safe, chainId: 137, block: 42n, timestamp: 42n, version: "1.4.1", owners: [signer], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 10n, warnings: [] }, signers: [{ ...config, singleton: safe, address: signer }] };
  function rpc() {
    const attackerHash = localSafeHash(137, safe, [payer, 10n, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress], 0n);
    const readContract = vi.fn().mockResolvedValue(attackerHash);
    const call = vi.fn();
    const client = { getCode: vi.fn().mockResolvedValue("0x"), getStorageAt: vi.fn().mockResolvedValue(toHex(0n, { size: 32 })), readContract, call } as unknown as PublicClient;
    return { client, readContract, call, attackerHash };
  }
  it("ignores a malicious RPC hash and signs only the locally assembled simulation", async () => {
    const { client, readContract, attackerHash } = rpc();
    const plan = await prepareSimulation(client, diagnosis, signer, { recipient, payer, amount: 1n });
    expect(readContract).not.toHaveBeenCalled();
    expect(plan.challenge).not.toBe(attackerHash);
    expect(plan.challenge).toBe(localSafeHash(137, safe, plan.args, plan.nonce));
    expect(plan.nonce).toBeGreaterThanOrEqual(1n << 255n);
    const authenticator = vi.fn();
    authenticator(simulationChallenge(plan));
    expect(authenticator).toHaveBeenCalledWith(plan.challenge);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.args)).toBe(true);
    expect(Object.isFrozen(plan.snapshot)).toBe(true);
  });
  it("rejects a substituted challenge before the authenticator or signature disclosure", async () => {
    const { client, readContract, call, attackerHash } = rpc();
    const plan = await prepareSimulation(client, diagnosis, signer, { recipient, payer, amount: 1n });
    const changed = { ...plan, challenge: attackerHash };
    const authenticator = vi.fn();
    expect(() => authenticator(simulationChallenge(changed))).toThrow(/hash/);
    expect(authenticator).not.toHaveBeenCalled();
    await expect(simulateWithdrawal(client, changed, "0xaabb")).rejects.toThrow(/hash/);
    expect(readContract).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
  });
  it("rejects a current-nonce transaction even if its local hash is internally consistent", async () => {
    const { client } = rpc();
    const plan = await prepareSimulation(client, diagnosis, signer, { recipient, payer, amount: 1n });
    expect(() => simulationChallenge({ ...plan, nonce: 0n, challenge: localSafeHash(137, safe, plan.args, 0n) })).toThrow(/Nonce/);
  });
  it("also calculates ordinary Safe proposal hashes without RPC", async () => {
    const { client, readContract, attackerHash } = rpc();
    const hash = await safeHash(client, { kind: "safe", chainId: 137, account: safe, call: { to: recipient, value: 1n, data: "0x" }, safeNonce: 0n, label: "test" });
    expect(readContract).not.toHaveBeenCalled(); expect(hash).not.toBe(attackerHash);
  });
  it("binds chain, Safe, nonce and every transaction field", () => {
    const args: SafeHashArgs = [recipient, 1n, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress];
    const hash = localSafeHash(137, safe, args, 7n);
    expect(localSafeHash(100, safe, args, 7n)).not.toBe(hash);
    expect(localSafeHash(137, payer, args, 7n)).not.toBe(hash);
    expect(localSafeHash(137, safe, args, 8n)).not.toBe(hash);
    const replacements = [payer, 2n, "0xabcd", 1, 1n, 1n, 1n, payer, payer];
    for (const [index, replacement] of replacements.entries()) {
      const changed: unknown[] = [...args]; changed[index] = replacement;
      expect(localSafeHash(137, safe, changed as unknown as SafeHashArgs, 7n)).not.toBe(hash);
    }
  });
});
