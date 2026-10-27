import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkExternalAccess } from '../src/prototype/guided-access';
import { publicClient } from '../src/core/client';
import { inspectAccount } from '../src/core/inspect';
vi.mock('../src/catalog/chains', () => ({ chains: [{ id: 137, name: 'Polygon' }, { id: 100, name: 'Gnosis' }] }));
vi.mock('../src/core/client', () => ({ publicClient: vi.fn(), same: (a: string, b: string) => a.toLowerCase() === b.toLowerCase() }));
vi.mock('../src/core/inspect', () => ({ inspectAccount: vi.fn(), assertSupportedSafe: vi.fn() }));
vi.mock('../src/core/ownerHistory', () => ({ discoveryRpc: () => 'https://example.invalid' }));
const safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', wallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const snapshot = (owner = wallet, threshold = 1n) => ({ owners: [owner], threshold, passkey: 'detected', recoveries: [{ supported: true, threshold: 1n, guardians: [wallet] }] });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publicClient).mockReturnValue({ getCode: vi.fn().mockResolvedValue('0x1234') } as never);
  vi.mocked(inspectAccount).mockResolvedValue(snapshot() as never);
});
describe('external access before inventory', () => {
  it('allows only a wallet that can sign alone on every deployed network', async () => {
    expect((await checkExternalAccess(safe, wallet, new AbortController().signal)).ready).toBe(true);
    vi.mocked(inspectAccount).mockResolvedValue(snapshot(wallet, 2n) as never);
    const result = await checkExternalAccess(safe, wallet, new AbortController().signal);
    expect(result.ready).toBe(false);
    expect(result.networks.every(n => n.status === 'guardian')).toBe(true);
  });
  it('does not confuse a guardian with the passkey owner or accept one-chain ownership', async () => {
    vi.mocked(inspectAccount).mockResolvedValueOnce(snapshot() as never).mockResolvedValueOnce(snapshot(safe) as never);
    const result = await checkExternalAccess(safe, wallet, new AbortController().signal);
    expect(result.ready).toBe(false);
    expect(result.networks.map(n => n.status)).toEqual(['owner', 'guardian']);
  });
  it('unknown state blocks access; undeployed networks do not create recovery requirements', async () => {
    vi.mocked(publicClient).mockReturnValueOnce({ getCode: vi.fn().mockResolvedValue('0x') } as never);
    expect((await checkExternalAccess(safe, wallet, new AbortController().signal)).ready).toBe(true);
    vi.mocked(inspectAccount).mockRejectedValueOnce(Error('RPC unavailable'));
    expect((await checkExternalAccess(safe, wallet, new AbortController().signal)).ready).toBe(false);
  });
  it('no deployed Safe is never considered authorized; cancellation propagates', async () => {
    vi.mocked(publicClient).mockReturnValue({ getCode: vi.fn().mockResolvedValue('0x') } as never);
    expect((await checkExternalAccess(safe, wallet, new AbortController().signal)).ready).toBe(false);
    const controller = new AbortController(); controller.abort();
    await expect(checkExternalAccess(safe, wallet, controller.signal)).rejects.toThrow();
  });
});
