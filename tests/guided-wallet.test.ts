import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({init:vi.fn(),qr:vi.fn()}));
vi.mock('@walletconnect/ethereum-provider',()=>({default:{init:m.init}}));
vi.mock('qrcode/lib/browser.js',()=>({default:{toDataURL:m.qr}}));
import { connectQrWallet } from '../src/prototype/guided-wallet';
let events:Map<string,(value:string)=>void>,provider:{session?:object;connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>;on:ReturnType<typeof vi.fn>;removeListener:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('location',{origin:'https://bunker.usepicnic.com:8443'});vi.stubGlobal('window',{isSecureContext:true});
 events=new Map();provider={connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),on:vi.fn((name,fn)=>events.set(name,fn)),removeListener:vi.fn((name)=>events.delete(name))};m.init.mockResolvedValue(provider);m.qr.mockResolvedValue('data:image/png;base64,qr');
});
afterEach(()=>vi.unstubAllGlobals());
it('initializes only on demand, uses a locally rendered QR and cleans up its listener',async()=>{
 const show=vi.fn();provider.connect.mockImplementation(async()=>{events.get('display_uri')?.('wc:pairing');await Promise.resolve();});
 expect(m.init).not.toHaveBeenCalled();expect(await connectQrWallet(new AbortController().signal,show)).toBe(provider);
 expect(m.init).toHaveBeenCalledWith(expect.objectContaining({showQrModal:false,telemetryEnabled:false,metadata:expect.objectContaining({url:'https://bunker.usepicnic.com:8443'})}));expect(show).toHaveBeenCalledWith('wc:pairing','data:image/png;base64,qr');expect(events.size).toBe(0);
});
it('canceling QR pairing rejects promptly and drops a late session',async()=>{
 let finish!:()=>void;provider.connect.mockImplementation(()=>new Promise<void>(r=>finish=r));const abort=new AbortController();const pending=connectQrWallet(abort.signal,vi.fn());await vi.waitFor(()=>expect(provider.connect).toHaveBeenCalled());abort.abort();await expect(pending).rejects.toThrow();finish();await Promise.resolve();expect(provider.disconnect).toHaveBeenCalled();expect(events.size).toBe(0);
});
it('does not initialize after cancellation or from another origin',async()=>{
 const abort=new AbortController();abort.abort();await expect(connectQrWallet(abort.signal,vi.fn())).rejects.toThrow();vi.stubGlobal('location',{origin:'https://example.test'});await expect(connectQrWallet(new AbortController().signal,vi.fn())).rejects.toThrow();expect(m.init).not.toHaveBeenCalled();
});
it('reports QR encoding failure promptly instead of leaving a dead loading screen',async()=>{
 m.qr.mockRejectedValueOnce(Error('canvas unavailable'));provider.connect.mockImplementation(()=>{events.get('display_uri')?.('wc:pairing');return new Promise(()=>{});});
 await expect(connectQrWallet(new AbortController().signal,vi.fn())).rejects.toThrow(/gerar o QR/);expect(events.size).toBe(0);expect(provider.disconnect).toHaveBeenCalled();
});
it('ignores a QR image that finishes after a session connected',async()=>{
 let image!:(value:string)=>void;m.qr.mockImplementationOnce(()=>new Promise(r=>image=r));provider.connect.mockImplementation(async()=>{events.get('display_uri')?.('wc:pairing');});const show=vi.fn();await connectQrWallet(new AbortController().signal,show);image('data:image/png;base64,late');await Promise.resolve();expect(show).not.toHaveBeenCalled();
});
