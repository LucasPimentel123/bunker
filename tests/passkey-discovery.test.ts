import { describe, expect, it, vi } from "vitest";
import { getAddress, toHex, type Address } from "viem";
import { identifyPasskey, recoverPublicKeys, predictPasskeySigners, discoveryChallenge, type PasskeyProof } from "../src/proof/passkeyDiscovery";
import { BUNKER_ORIGIN, assertLocalBunker } from "../src/proof/localBunker";
import { EXTENSION_ORIGIN } from "../src/extension/context";
import { lookupSafeHints } from "../src/extension/accountIndex";
import { testKey, testAssertion } from "./helpers/passkey";
const origin = EXTENSION_ORIGIN;
function proof(key: ReturnType<typeof testKey>, n: number, options = {}): PasskeyProof {
  const challenge = toHex(n, { size: 32 });
  return { credentialId: "AQID", challenge, assertion: testAssertion(key, challenge, { origin, ...options }) };
}
describe("passkey identity without Picnic metadata", () => {
  it("recovers the actual public key from two independently signed messages (Node crypto oracle)", async () => {
    for (let i = 0; i < 12; i++) {
      const key = testKey(), a = proof(key, 1), b = proof(key, 2);
      const candidates = recoverPublicKeys(a, origin);
      expect(candidates.length).toBeGreaterThan(1);
      expect(candidates).toContainEqual({ x: key.config.x, y: key.config.y });
      expect(await identifyPasskey(a, b, origin)).toEqual({ x: key.config.x, y: key.config.y });
    }
  });
  it("rejects replay, another credential, another key, incorrect RP/origin/flags/challenge and malformed DER", async () => {
    const key = testKey(), first = proof(key, 1), second = proof(key, 2);
    await expect(identifyPasskey(first, first, origin)).rejects.toThrow(/diferentes/);
    await expect(identifyPasskey(first, { ...second, credentialId: "BAUG" }, origin)).rejects.toThrow(/mesma passkey/);
    await expect(identifyPasskey(first, proof(testKey(), 2), origin)).rejects.toThrow(/única/);
    for (const options of [{ origin: "https://evil.example" }, { rpId: "evil.example" }, { flags: 1 }, { flags: 4 }, { crossOrigin: true }]) {
      await expect(identifyPasskey(first, proof(key, 2, options), origin)).rejects.toThrow();
    }
    await expect(identifyPasskey(first, { ...second, challenge: toHex(3, { size: 32 }) }, origin)).rejects.toThrow();
    await expect(identifyPasskey(first, { ...second, assertion: { ...second.assertion, signature: new Uint8Array([0]) } }, origin)).rejects.toThrow(/DER/);
  });
  it("uses fresh local challenges and predicts all three pinned deployment configurations", () => {
    expect(discoveryChallenge()).not.toBe(discoveryChallenge());
    const result = predictPasskeySigners(testKey().config);
    expect(result.map(v => v.version)).toEqual(["0.2.0", "0.2.1", "0.2.1"]);
    expect(new Set(result.map(v => v.address)).size).toBe(3);
  });
});

describe("public index is only an untrusted address hint", () => {
  const owner = getAddress("0x4444444444444444444444444444444444444444");
  const safe = getAddress("0x3333333333333333333333333333333333333333");
  it("uses a fixed endpoint without cookies, sends only public signer, and deduplicates", async () => {
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify({ count: 2, next: null, results: [{ address: safe }, { address: safe }] })));
    expect(await lookupSafeHints(137, owner, fetchIndex)).toEqual({ addresses: [safe], incomplete: false });
    expect(fetchIndex.mock.calls[0]).toMatchObject([`https://api.safe.global/tx-service/pol/api/v2/owners/${owner}/safes/?limit=100&offset=0`, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }]);
  });
  it("never follows an untrusted next URL, bounds pagination and marks incomplete", async () => {
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify({ count: 400, next: "https://evil.example/steal", results: Array.from({ length: 100 }, () => ({ address: safe })) })));
    expect(await lookupSafeHints(100, owner, fetchIndex)).toEqual({ addresses: [safe], incomplete: true });
    expect(fetchIndex).toHaveBeenCalledTimes(3);
    for (const call of fetchIndex.mock.calls as unknown as [string, RequestInit][]) expect(call[0]).toMatch(/^https:\/\/api.safe.global\/tx-service\/gno\//);
  });
  it("rejects malformed, oversized and unavailable responses instead of returning an empty account list", async () => {
    for (const data of [null, {}, { count: 1, next: null, results: [{}] }, { count: 1, next: null, results: [{ address: "nope" }] }, { count: -1, next: null, results: [] }]) {
      await expect(lookupSafeHints(137, owner, async () => new Response(JSON.stringify(data)))).rejects.toThrow();
    }
    await expect(lookupSafeHints(137, owner, async () => new Response("x".repeat(2_000_001)))).rejects.toThrow(/limite/);
    await expect(lookupSafeHints(137, owner, async () => new Response("", { status: 503 }))).rejects.toThrow(/503/);
    const fetchIndex = vi.fn();
    await expect(lookupSafeHints(9999, owner as Address, fetchIndex)).rejects.toThrow(/Rede/);
    expect(fetchIndex).not.toHaveBeenCalled();
    expect(await lookupSafeHints(137, owner, async () => new Response(JSON.stringify({ count: 1, next: null, results: [] })))).toEqual({ addresses: [], incomplete: true });
  });
});


describe("local Bunker origin", () => {
  it("pins the exact HTTPS origin and verifies discovery assertions from it", async () => {
    expect(() => assertLocalBunker(BUNKER_ORIGIN, true)).not.toThrow();
    for (const invalid of ["https://usepicnic.com", "http://bunker.usepicnic.com:8443", "https://bunker.usepicnic.com.evil:8443", "https://bunker.usepicnic.com:9443"]) expect(() => assertLocalBunker(invalid, true)).toThrow();
    expect(() => assertLocalBunker(BUNKER_ORIGIN, false)).toThrow();
    const key = testKey();
    expect(await identifyPasskey(proof(key, 1, { origin: BUNKER_ORIGIN }), proof(key, 2, { origin: BUNKER_ORIGIN }), BUNKER_ORIGIN)).toEqual({ x: key.config.x, y: key.config.y });
    await expect(identifyPasskey(proof(key, 1), proof(key, 2), BUNKER_ORIGIN)).rejects.toThrow(/Origem/);
  });
});
