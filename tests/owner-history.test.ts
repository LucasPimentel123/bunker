import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toHex, type PublicClient } from "viem";
import { createOwnerHistoryScanner, discoveryRpc, independentAccountHints } from "../src/core/ownerHistory";
import { predictPicnicAccount } from "../src/core/discovery";
import { chains, defaultReadRpcs } from "../src/catalog/chains";
import origins from "../scripts/proof/read-origins.json";
const owner = getAddress("0x1111111111111111111111111111111111111111"), safe = getAddress("0x2222222222222222222222222222222222222222");
const topic = keccak256(stringToHex("AddedOwner(address)"));
const log = (block: bigint, who = owner) => ({ address: safe, data: encodeAbiParameters([{ type: "address" }], [who]), topics: [topic], blockNumber: toHex(block), removed: false });
const fixture = (request = vi.fn(async () => [] as unknown[])) => ({ client: { request, getChainId: async () => 137, getBlockNumber: async () => 100_000n, getCode: async () => "0x" } as unknown as PublicClient, request });
describe("independent on-chain discovery", () => {
  it("resumes older ranges without replaying completed work", async () => {
    const { client, request } = fixture();
    const scan = createOwnerHistoryScanner();
    expect((await scan(client, 137, owner, undefined, 1)).incomplete).toBe(true);
    await scan(client, 137, owner, undefined, 1);
    const ranges = request.mock.calls as unknown as [{ params: [{ fromBlock: string; toBlock: string }] }][];
    expect(BigInt(ranges[0][0].params[0].fromBlock)).toBe(80_001n);
    expect(BigInt(ranges[1][0].params[0].toBlock)).toBe(80_000n);
  });
  it("finds AddedOwner hints, ignores another owner, never declares an unfinished scan complete", async () => {
    const { client } = fixture(vi.fn(async () => [log(90_000n), log(90_001n, safe)]));
    const found = await createOwnerHistoryScanner()(client, 137, owner);
    expect(found.addresses).toEqual([safe]); expect(found.incomplete).toBe(true);
  });
  it("discovers an original owner from SafeSetup's non-indexed owner array", async () => {
    const setup = { ...log(90_000n),
      topics: [keccak256(stringToHex("SafeSetup(address,address[],uint256,address,address)")), toHex(1, { size: 32 })],
      data: encodeAbiParameters([{ type: "address[]" }, { type: "uint256" }, { type: "address" }, { type: "address" }], [[owner], 1n, safe, safe]),
    };
    const { client } = fixture(vi.fn(async () => [setup]));
    expect((await createOwnerHistoryScanner()(client, 137, owner)).addresses).toEqual([safe]);
  });
  it("keeps an unavailable range pending after every retry, rather than reporting no accounts", async () => {
    const { client, request } = fixture(vi.fn(async () => { throw new Error("log range rejected"); }));
    const scan = createOwnerHistoryScanner();
    await scan(client, 137, owner);
    const result = await scan(client, 137, owner);
    expect(result.incomplete).toBe(true);
    expect(result.issues?.[0]).toContain("posição foi preservada");
    const calls = request.mock.calls as unknown as [{ params: [{ toBlock: string }] }][];
    expect(calls.every(call => call[0].params[0].toBlock === toHex(100_000))).toBe(true);
  });
  it("does not advance a failed/malformed range and retries it with a smaller window", async () => {
    const { client, request } = fixture(vi.fn(async () => [log(1n)]));
    const scan = createOwnerHistoryScanner();
    const result = await scan(client, 137, owner, undefined, 1);
    expect(result.addresses).toEqual([]); expect(result.incomplete).toBe(true);
    request.mockResolvedValue([]);
    await scan(client, 137, owner, undefined, 1);
    const calls = request.mock.calls as unknown as [{ params: [{ fromBlock: string; toBlock: string }] }][];
    expect(BigInt(calls[1][0].params[0].toBlock)).toBe(100_000n);
    expect(BigInt(calls[1][0].params[0].fromBlock)).toBe(90_001n);
  });
  it("requires the expected chain before consulting history", async () => {
    const { client, request } = fixture();
    await expect(createOwnerHistoryScanner()(client, 1, owner)).rejects.toThrow(/chain/);
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps deterministic and history hints when the index is completely offline", async () => {
    const { client } = fixture();
    client.getCode = vi.fn(async () => "0x1234" as const);
    const index = vi.fn(async () => { throw new Error("offline"); });
    const history = vi.fn(async () => ({ addresses: [safe], incomplete: true, issues: ["history pending"] }));
    const result = await independentAccountHints(client, 137, owner, undefined, index, history);
    expect(result.addresses).toEqual([predictPicnicAccount(owner), safe]);
    expect(result.incomplete).toBe(true); expect(result.issues).toContain("history pending");
  });
  it("does not scan history unnecessarily when index hints are available", async () => {
    const { client } = fixture();
    const history = vi.fn();
    const result = await independentAccountHints(client, 137, owner, undefined, async () => ({ addresses: [safe], incomplete: false }), history);
    expect(result.addresses).toEqual([safe]); expect(history).not.toHaveBeenCalled();
  });
  it("pins every catalogue RPC origin in local Bunker's CSP allowlist", () => {
    for (const chain of chains) for (const rpc of defaultReadRpcs(chain)) expect(origins).toContain(new URL(rpc).origin);
    for (const chain of chains) expect(origins).toContain(new URL(discoveryRpc(chain.id)).origin);
    expect(origins.every(origin => !origin.includes("picnic") && origin.startsWith("https://"))).toBe(true);
  });
});
