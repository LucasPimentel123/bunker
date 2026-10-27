import { afterEach, describe, expect, it, vi } from "vitest";
import { toHex } from "viem";
import { assertExtensionContext, EXTENSION_ORIGIN } from "../src/extension/context";
import { readOnlyProvider, extensionNetworks } from "../src/extension/transport";
import { encodeAssertion, PROOF_ORIGIN, requestPasskey } from "../src/proof/passkey";
import { testKey, testAssertion } from "./helpers/passkey";
import identity from "../extension/identity.json";

afterEach(() => vi.unstubAllGlobals());
describe("extension passkey origin", () => {
  const challenge = toHex(42n, { size: 32 });
  it("validates extension-origin assertions and rejects web or other-extension origins", async () => {
    const keys = testKey();
    const assertion = testAssertion(keys, challenge, { origin: EXTENSION_ORIGIN });
    await expect(encodeAssertion(assertion, challenge, keys.config, EXTENSION_ORIGIN)).resolves.toMatch(/^0x/);
    await expect(encodeAssertion(assertion, challenge, keys.config)).rejects.toThrow(/Origem/);
    for (const origin of [PROOF_ORIGIN, "https://usepicnic.com", "chrome-extension://" + "a".repeat(32)]) {
      await expect(encodeAssertion(testAssertion(keys, challenge, { origin }), challenge, keys.config, EXTENSION_ORIGIN)).rejects.toThrow(/Origem/);
    }
    await expect(encodeAssertion(testAssertion(keys, challenge, { origin: EXTENSION_ORIGIN, rpId: "example.org" }), challenge, keys.config, EXTENSION_ORIGIN)).rejects.toThrow(/domínio/);
  });
  it("requires the pinned extension ID and origin together", () => {
    expect(() => assertExtensionContext(EXTENSION_ORIGIN, identity.id)).not.toThrow();
    for (const [origin, id] of [[PROOF_ORIGIN, identity.id], [EXTENSION_ORIGIN, undefined], [EXTENSION_ORIGIN, "a".repeat(32)], [`${EXTENSION_ORIGIN}.evil`, identity.id]]) {
      expect(() => assertExtensionContext(origin!, id)).toThrow();
    }
  });
  it("checks page origin before opening an authenticator prompt", async () => {
    const get = vi.fn();
    vi.stubGlobal("location", { origin: PROOF_ORIGIN });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { credentials: { get } });
    await expect(requestPasskey(challenge, undefined, EXTENSION_ORIGIN)).rejects.toThrow(/origem/);
    expect(get).not.toHaveBeenCalled();
  });
  it("requests only existing Picnic credentials with required user verification", async () => {
    class FakeAssertion {}
    class FakeCredential { response = new FakeAssertion(); rawId = Uint8Array.of(1, 2, 3).buffer; }
    const get = vi.fn().mockResolvedValue(new FakeCredential());
    vi.stubGlobal("location", { origin: EXTENSION_ORIGIN });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { credentials: { get } });
    vi.stubGlobal("PublicKeyCredential", FakeCredential);
    vi.stubGlobal("AuthenticatorAssertionResponse", FakeAssertion);
    await requestPasskey(challenge, undefined, EXTENSION_ORIGIN);
    expect(get.mock.calls[0][0].publicKey).toMatchObject({ rpId: "usepicnic.com", userVerification: "required", timeout: 60000 });
    expect(get.mock.calls[0][0].publicKey.allowCredentials).toBeUndefined();
    await requestPasskey(challenge, "AQID", EXTENSION_ORIGIN);
    expect(get.mock.calls[1][0].publicKey.allowCredentials[0].id).toEqual(Uint8Array.of(1, 2, 3));
    await expect(requestPasskey(challenge, "AQIE", EXTENSION_ORIGIN)).rejects.toThrow(/outra credencial/);
  });
});

describe("extension read-only RPC boundary", () => {
  function echo() {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x89" }));
    });
  }
  it("normalizes omitted params and uses only the configured HTTPS host without cookies or redirects", async () => {
    const fetchRpc = echo();
    const provider = readOnlyProvider(137, fetchRpc);
    expect(await provider.request({ method: "eth_chainId" })).toBe("0x89");
    expect(fetchRpc.mock.calls[0][0]).toBe(extensionNetworks[0].rpc);
    const options = fetchRpc.mock.calls[0][1]!;
    expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(JSON.parse(options.body as string)).toMatchObject({ method: "eth_chainId", params: [] });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("blocks all sending, signing, admin, malformed and unsupported-network calls before fetch", async () => {
    const fetchRpc = echo();
    const provider = readOnlyProvider(137, fetchRpc);
    for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "wallet_sendCalls", "anvil_setStorageAt"]) await expect(provider.request({ method, params: [] })).rejects.toThrow(/somente consultas/);
    await expect(provider.request({ method: "eth_call", params: {} })).rejects.toThrow();
    await expect(provider.request({ method: "eth_chainId", params: null })).rejects.toThrow();
    await expect(provider.request({ method: "eth_call", params: ["a".repeat(100001)] })).rejects.toThrow(/grande/);
    expect(() => readOnlyProvider(999999, fetchRpc)).toThrow(/redes/);
    expect(fetchRpc).not.toHaveBeenCalled();
  });
  it("rejects substituted response IDs and invalid response envelopes", async () => {
    for (const value of [{ jsonrpc: "2.0", id: 99, result: "0x89" }, [], { jsonrpc: "2.0", id: 1, result: "0x89", error: {} }, { jsonrpc: "2.0", id: 1, error: { code: "not numeric", message: "x" } }]) {
      await expect(readOnlyProvider(137, async () => new Response(JSON.stringify(value))).request({ method: "eth_chainId" })).rejects.toThrow(/inválid|corresponde/);
    }
  });
  it("bounds streamed responses and reports provider failures without signing", async () => {
    await expect(readOnlyProvider(137, async () => new Response("x".repeat(2_000_001))).request({ method: "eth_chainId" })).rejects.toThrow(/limite/);
    await expect(readOnlyProvider(137, async () => new Response("", { status: 429 })).request({ method: "eth_chainId" })).rejects.toThrow(/429/);
    await expect(readOnlyProvider(137, async () => { throw new Error("secret provider diagnostic"); }).request({ method: "eth_chainId" })).rejects.toThrow(/Confira sua conexão/);
    const provider = readOnlyProvider(137, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } })));
    await expect(provider.request({ method: "eth_call", params: [] })).rejects.toMatchObject({ code: -32000, message: "execution reverted" });
  });
  it("retries a lagging RPC at the exact pinned block, with a bounded attempt count", async () => {
    const bodies: string[] = [];
    const fetchRpc = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(init!.body as string);
      const { id } = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...(bodies.length === 1 ? { error: { code: -32000, message: "header not found" } } : { result: "0x1" }) }));
    });
    expect(await readOnlyProvider(137, fetchRpc).request({ method: "eth_call", params: [{ to: "0x1111111111111111111111111111111111111111" }, "0x1234"] })).toBe("0x1");
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    const unavailable = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } })));
    await expect(readOnlyProvider(137, unavailable).request({ method: "eth_getCode", params: ["0x1111111111111111111111111111111111111111", "0x1234"] })).rejects.toThrow(/header not found/);
    expect(unavailable).toHaveBeenCalledTimes(3);
  });
});
