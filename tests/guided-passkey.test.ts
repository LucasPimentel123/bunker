import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ request: vi.fn(), discover: vi.fn(), resolve: vi.fn(), identify: vi.fn() }));
vi.mock('../src/proof/passkey', () => ({ requestPasskey: m.request, assertionFrom: () => ({ test: true }), base64url: () => 'credential' }));
vi.mock('../src/proof/passkeyDiscovery', () => ({ discoveryChallenge: () => '0x1234', identifyPasskey: m.identify }));
vi.mock('../src/proof/discoveryFlow', () => ({ startDiscovery: (proof: unknown) => ({ proof, candidates: [{ x: '0x01', y: '0x02' }] }), discoverCandidateAccounts: m.discover, resolveDiscovery: m.resolve, keyId: (k: { x: string; y: string }) => k.x + ':' + k.y }));
vi.mock('../src/core/client', () => ({ publicClient: () => ({}) }));
vi.mock('../src/core/ownerHistory', () => ({ discoveryRpc: () => 'https://example.test', independentAccountHints: vi.fn() }));
import { discoverPasskey, confirmPasskey, resetPasskey } from '../src/prototype/guided-passkey';
const key = { x: '0x01', y: '0x02' }, safe = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
beforeEach(() => {
 vi.clearAllMocks();resetPasskey();vi.stubGlobal('location', { origin: 'https://bunker.usepicnic.com:8443' });vi.stubGlobal('window', { isSecureContext: true });
 m.request.mockResolvedValue({ rawId: new ArrayBuffer(1) });m.identify.mockResolvedValue(key);
 m.discover.mockResolvedValue({ chainId: 137, accounts: [{ publicKey: key, diagnosis: { snapshot: { address: safe } } }], issues: [] });
 m.resolve.mockReturnValue({ key, matches: [key], needsSecondAssertion: false });
});
afterEach(() => vi.unstubAllGlobals());
describe('guided passkey identification boundaries', () => {
 it('uses the fixed trusted origin, discovery challenge and cancellation signal', async () => {
  const controller = new AbortController(), progress = vi.fn();
  const result = await discoverPasskey(controller.signal, progress);
  expect(m.request).toHaveBeenCalledOnce();expect(m.request).toHaveBeenCalledWith('0x1234', undefined, 'https://bunker.usepicnic.com:8443', controller.signal);
  expect(result.addresses).toEqual([safe]);expect(result.needsSecond).toBe(false);expect(progress).toHaveBeenCalled();
 });
 it('does not expose accounts when multiple verified key candidates remain', async () => {
  m.resolve.mockReturnValue({ key: undefined, matches: [key, { x: '0x03', y: '0x04' }], needsSecondAssertion: true });
  const result = await discoverPasskey(new AbortController().signal, () => {});
  expect(result.addresses).toEqual([]);expect(result.needsSecond).toBe(true);expect(m.request).toHaveBeenCalledOnce();
 });
 it('rejects an unsolicited second assertion', async () => {
  await expect(confirmPasskey(new AbortController().signal, () => {})).rejects.toThrow('Repita');expect(m.request).not.toHaveBeenCalled();
 });
 it('never opens credentials after cancellation or on a foreign origin', async () => {
  const controller = new AbortController();controller.abort();await expect(discoverPasskey(controller.signal, () => {})).rejects.toThrow();expect(m.request).not.toHaveBeenCalled();
  vi.stubGlobal('location', { origin: 'https://example.test' });await expect(discoverPasskey(new AbortController().signal, () => {})).rejects.toThrow('Abra');expect(m.request).not.toHaveBeenCalled();
 });
 it('ignores a credential that resolves after cancellation', async () => {
  let resolve!: (value: unknown) => void;m.request.mockImplementation(() => new Promise(r => { resolve = r; }));const c = new AbortController();const pending = discoverPasskey(c.signal, () => {});c.abort();resolve({ rawId: new ArrayBuffer(1) });await expect(pending).rejects.toThrow();expect(m.discover).not.toHaveBeenCalled();
 });
 it('a failed RPC never falls back to a preloaded account', async () => {
  m.discover.mockRejectedValue(new Error('RPC failed'));m.resolve.mockReturnValue({ key: undefined, matches: [], needsSecondAssertion: false });
  const result = await discoverPasskey(new AbortController().signal, () => {});expect(result.addresses).toEqual([]);expect(result.issues.length).toBeGreaterThan(0);
 });
});
