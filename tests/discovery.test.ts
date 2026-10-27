import { beforeEach, describe, expect, it, vi } from "vitest";
import { pad, toHex, zeroAddress, type Address, type PublicClient } from "viem";
import { gnosis } from "viem/chains";
import { cardControllerTopic, discoverCards, discoverPicnicAccount, predictCardAccount, predictPicnicAccount } from "../src/core/discovery";
import { inspectAccount } from "../src/core/inspect";
import { inspectCard } from "../src/core/card";
import { ReadPool, type ReadCheckpoint } from "../src/core/reads";
import type { AccountSnapshot } from "../src/core/types";
vi.mock("../src/core/inspect", async importOriginal => ({ ...await importOriginal<typeof import("../src/core/inspect")>(), inspectAccount: vi.fn() }));
vi.mock("../src/core/card", async original => ({ ...await original<typeof import("../src/core/card")>(), inspectCard: vi.fn() }));
const owner = "0x1111111111111111111111111111111111111111" as Address;
const card = "0x2222222222222222222222222222222222222222" as Address;
const stranger = "0x3333333333333333333333333333333333333333" as Address;
const singleton = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as Address;
const snapshot: AccountSnapshot = { address: predictPicnicAccount(owner), chainId: 100, version: "1.4.1", owners: [owner], threshold: 1n, nonce: 0n, block: 1n, timestamp: 1n, nativeBalance: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], warnings: [] };
const moduleAddress = "0x4444444444444444444444444444444444444444" as Address;
const clone = "0x363d3d373d3d3d363d7322d903fd45f441f51bcad198d14eba8a75ea1ef05af43d82803e903d91602b57fd5bf3";
const event = (controller = owner, emitter = moduleAddress, block = 90n) => ({ address: emitter, topics: [cardControllerTopic], data: pad(controller), blockNumber: toHex(block), removed: false });
function fixture(signal = new AbortController().signal, checkpoint: ReadCheckpoint = new Map()) {
  const client = { getChainId: vi.fn(async () => 100), getBlockNumber: vi.fn(async () => 100n),
    getCode: vi.fn(async ({address}: {address: Address}): Promise<`0x${string}`> => address === moduleAddress ? clone : "0x1234"), getStorageAt: vi.fn(async () => pad(singleton)),
    readContract: vi.fn(async () => card), request: vi.fn(async (_args: unknown): Promise<ReturnType<typeof event>[]> => []) };
  return { client, checkpoint, pool: new ReadPool(gnosis, [{ url: "http://localhost:18547", client: client as unknown as PublicClient }], signal, 0, undefined, checkpoint) };
}
function validCard() {
  vi.mocked(inspectCard).mockImplementation(async (_client, address) => address === card ? [{ address: moduleAddress, card, delayVersion: "v5", controllers: [owner], head: 0n, tail: 0n, cooldown: 180n, expiration: 0n }] : []);
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(inspectAccount).mockResolvedValue(snapshot); vi.mocked(inspectCard).mockResolvedValue([]); });
describe("automatic Picnic account and card discovery", () => {
  it("selects the predicted Picnic Safe only after verifying current ownership", async () => {
    const { pool } = fixture();
    expect(await discoverPicnicAccount(pool, owner)).toBe(predictPicnicAccount(owner));
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, owners: [stranger] });
    expect(await discoverPicnicAccount(pool, owner)).toBeUndefined();
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, warnings: ["Unrecognized Safe singleton: transactions disabled"] });
    await expect(discoverPicnicAccount(pool, owner)).rejects.toThrow();
  });
  it("does not mistake an undeployed prediction for a usable account", async () => {
    const { pool, client } = fixture(); client.getCode.mockResolvedValue("0x");
    expect(await discoverPicnicAccount(pool, owner)).toBeUndefined(); expect(inspectAccount).not.toHaveBeenCalled();
  });
  it("finds an unused replacement from its controller event, without transfer history", async () => {
    const { pool, client } = fixture(); client.request.mockResolvedValue([event()]); validCard();
    const found = await discoverCards(pool, owner);
    expect(found.addresses).toEqual([card]); expect(found.issues).toEqual([]);
    expect(client.request).toHaveBeenCalledWith({method: "eth_getLogs", params: [{fromBlock: "0x0", toBlock: "0x64", topics: [cardControllerTopic]}]});
  });
  it("filters unrelated events before inspecting contracts, without a 64-counterparty cutoff", async () => {
    const {pool, client} = fixture(); validCard();
    client.request.mockResolvedValue([...Array.from({length: 100}, () => event(stranger)), event()]);
    expect((await discoverCards(pool, owner)).addresses).toEqual([card]);
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });
  it("rejects spoofed emitters, disabled controllers and a Delay not enabled on the card", async () => {
    const {pool,client} = fixture();client.request.mockResolvedValue([event()]);validCard();
    client.getCode.mockResolvedValue("0x1234");expect((await discoverCards(pool,owner)).addresses).toEqual([]);
    client.getCode.mockImplementation(async ({address}) => address === moduleAddress ? clone : "0x1234");
    vi.mocked(inspectCard).mockResolvedValue([{address: moduleAddress,card,delayVersion:"v5",controllers:[stranger],head:0n,tail:0n,cooldown:0n,expiration:0n}]);
    expect((await discoverCards(pool,owner)).addresses).toEqual([]);
    vi.mocked(inspectCard).mockImplementation(async (_client,address) => address===card?[{address:stranger,card,delayVersion:"v5",controllers:[owner],head:0n,tail:0n,cooldown:0n,expiration:0n}]:[]);
    expect((await discoverCards(pool,owner)).addresses).toEqual([]);
  });
  it("splits provider result limits and resumes the exact next page across pools", async () => {
    const first=fixture();validCard();
    first.client.request.mockImplementation(async (args:any) => args.params[0].fromBlock==='0x0' ? Array.from({length:1000},()=>event()) : [event()]);
    const partial=await discoverCards(first.pool,owner,2);
    expect(partial.addresses).toEqual([card]);expect(partial.incomplete).toBe(true);expect(partial.history.nextBlock).toBe('49');
    const second=fixture(undefined,first.checkpoint);const complete=await discoverCards(second.pool,owner);
    expect(second.client.request).toHaveBeenCalledWith(expect.objectContaining({params:[expect.objectContaining({fromBlock:'0x0',toBlock:'0x31'})]}));
    expect(complete.incomplete).toBe(false);expect(complete.addresses).toEqual([card]);
    expect(second.client.getBlockNumber).not.toHaveBeenCalled();
  });
  it("does not advance past malformed pages, retries failures and isolates account cursors", async () => {
    const f=fixture();f.client.request.mockResolvedValue([{...event(),blockNumber:'0xffff'}]);
    const bad=await discoverCards(f.pool,owner,1);expect(bad.incomplete).toBe(true);expect(bad.history.nextBlock).toBe('100');
    f.client.request.mockResolvedValue([]);expect((await discoverCards(f.pool,owner)).incomplete).toBe(false);
    await discoverCards(f.pool,stranger);expect(f.client.getBlockNumber).toHaveBeenCalledTimes(2);
  });
  it("checks new event blocks after completing history, while revalidating old links", async () => {
    const f=fixture();await discoverCards(f.pool,owner);f.client.getBlockNumber.mockResolvedValue(120n);
    f.client.request.mockResolvedValue([event(owner,moduleAddress,110n)]);validCard();
    const updated=await discoverCards(f.pool,owner);expect(updated.addresses).toEqual([card]);expect(updated.incomplete).toBe(false);
    expect(f.client.request).toHaveBeenLastCalledWith(expect.objectContaining({params:[expect.objectContaining({fromBlock:'0x65',toBlock:'0x78'})]}));
  });
  it("keeps RPC failures partial and cancellation never commits a late page", async () => {
    const abort=new AbortController(),f=fixture(abort.signal);
    f.client.request.mockImplementation(async()=>{abort.abort();return [event()];});
    await expect(discoverCards(f.pool,owner)).rejects.toThrow();
    const resumed=fixture(undefined,f.checkpoint);expect((await discoverCards(resumed.pool,owner)).addresses).toEqual([]);
    expect(resumed.client.request).toHaveBeenCalledWith(expect.objectContaining({params:[expect.objectContaining({fromBlock:'0x0',toBlock:'0x64'})]}));
    const failed=fixture();failed.client.request.mockRejectedValue(Error('RPC offline'));
    expect((await discoverCards(failed.pool,owner,2)).incomplete).toBe(true);
  });
  it("keeps an unsupported original card informational instead of a retryable failure", async () => {
    const { pool, client } = fixture(); client.getStorageAt.mockResolvedValue(pad(stranger));
    const found = await discoverCards(pool, owner);
    expect(found.addresses).toEqual([]); expect(found.issues).toEqual([]); expect(found.notes.join()).toContain("v5"); expect(inspectCard).not.toHaveBeenCalled();
  });
  it("cancels stale account discovery and refuses the wrong network", async () => {
    const abort = new AbortController(); abort.abort(); const cancelled = fixture(abort.signal);
    await expect(discoverPicnicAccount(cancelled.pool, owner)).rejects.toThrow(); expect(cancelled.client.getCode).not.toHaveBeenCalled();
    const wrong = fixture(); wrong.client.getChainId.mockResolvedValue(1);
    await expect(discoverPicnicAccount(wrong.pool, owner)).rejects.toThrow(/chain mismatch/);
  });
});
