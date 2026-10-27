import { describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress, type EIP1193Provider } from "viem";
import { destinationError, readPayerAccount } from "../src/proof/withdrawalWallet";
const safe = getAddress("0x3333333333333333333333333333333333333333");
const payer = getAddress("0x2222222222222222222222222222222222222222");
const other = getAddress("0x1111111111111111111111111111111111111111");
describe("connected gas payer", () => {
  it("reads the selected wallet without signing, switching chains or sending", async () => {
    const request = vi.fn(async () => [payer.toLowerCase()]);
    expect(await readPayerAccount({ request } as unknown as EIP1193Provider, payer)).toBe(payer);
    expect(request.mock.calls).toEqual([[{ method: "eth_accounts" }]]);
  });
  it("rejects disconnects, malformed accounts and stale payers", async () => {
    for (const result of [[], null, ["bad"], [other]]) {
      await expect(readPayerAccount({ request: async () => result } as unknown as EIP1193Provider, payer)).rejects.toThrow();
    }
  });
  it("times out a nonresponsive wallet", async () => {
    vi.useFakeTimers();
    try {
      const outcome = expect(readPayerAccount({ request: () => new Promise(() => {}) } as unknown as EIP1193Provider)).rejects.toThrow(/não respondeu/);
      await vi.advanceTimersByTimeAsync(8000);
      await outcome;
    } finally { vi.useRealTimers(); }
  });
});
describe("withdrawal destination", () => {
  const snapshot = { address: safe, recoveries: [{ guardians: [payer] }] };
  it("blocks the guardian in the form regardless of address casing", () => {
    expect(destinationError(snapshot, payer.toLowerCase())).toMatch(/guardian/);
    expect(destinationError(snapshot, payer)).toMatch(/guardian/);
    expect(destinationError(snapshot, other)).toBeUndefined();
  });
  it("blocks invalid, zero and source addresses", () => {
    expect(destinationError(snapshot, "bad")).toMatch(/válido/);
    expect(destinationError(snapshot, zeroAddress)).toMatch(/zero/);
    expect(destinationError(snapshot, safe)).toMatch(/origem/);
  });
});
