import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { createSafeIndexLookup } from "../src/extension/accountIndex";
const owner = getAddress("0x4444444444444444444444444444444444444444");
const safe = getAddress("0x3333333333333333333333333333333333333333");
const ok = () => new Response(JSON.stringify({ count: 1, next: null, results: [{ address: safe }] }));
const limited = (header?: string) => new Response("", { status: 429, headers: header ? { "Retry-After": header } : {} });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-23T12:00:00Z")); });
afterEach(() => vi.useRealTimers());
describe("Safe index request scheduling", () => {
  it("serializes networks, deduplicates concurrent lookups, and caches only hints", async () => {
    const times: number[] = [];
    const fetcher = vi.fn(async () => { times.push(Date.now()); return ok(); });
    const lookup = createSafeIndexLookup(fetcher);
    const first = lookup(137, owner), same = lookup(137, owner), second = lookup(100, owner);
    await vi.runAllTimersAsync();
    expect(await first).toEqual(await same);
    await second;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
    await lookup(137, owner);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_001);
    await lookup(137, owner);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(["5", "Fri, 23 Oct 2026 12:00:05 GMT"])("honors Retry-After %s across all networks with visible countdown", async header => {
    const times: number[] = [];
    const fetcher = vi.fn(async () => { times.push(Date.now()); return times.length === 1 ? limited(header) : ok(); });
    const progress = vi.fn();
    const lookup = createSafeIndexLookup(fetcher);
    const a = lookup(137, owner, progress), b = lookup(100, owner);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls.some(([text]) => /Nova tentativa em/.test(text))).toBe(true);
    await vi.runAllTimersAsync();
    expect((await a).addresses).toEqual([safe]);
    await b;
    expect(times[1] - times[0]).toBe(5000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1000);
  });
  it.each([undefined, "bad"])("bounds automatic retries and backs off with header %s", async header => {
    const times: number[] = [];
    const lookup = createSafeIndexLookup(async () => { times.push(Date.now()); return limited(header); });
    const assertion = expect(lookup(137, owner)).rejects.toThrow(/429.*20 s/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(times.map(t => t - times[0])).toEqual([0, 5000, 15000]);
  });
  it("does not shorten long cooldowns or let another network/manual retry bypass them", async () => {
    const fetcher = vi.fn(async () => limited("3600"));
    const lookup = createSafeIndexLookup(fetcher);
    await expect(lookup(137, owner)).rejects.toThrow(/3600 s/);
    await expect(lookup(100, owner)).rejects.toThrow(/3600 s/);
    await expect(lookup(137, owner)).rejects.toThrow(/3600 s/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not cache empty results or retry unrelated HTTP errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ count: 0, next: null, results: [] })));
    const lookup = createSafeIndexLookup(fetcher);
    await lookup(137, owner);
    const next = lookup(137, owner);
    await vi.runAllTimersAsync(); await next;
    expect(fetcher).toHaveBeenCalledTimes(2);
    const failed = vi.fn(async () => new Response("", { status: 403 }));
    await expect(createSafeIndexLookup(failed)(137, owner)).rejects.toThrow(/403/);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
