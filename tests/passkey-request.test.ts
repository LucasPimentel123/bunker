import { afterEach, expect, it, vi } from 'vitest';
import { requestPasskey } from '../src/proof/passkey';
const origin = 'https://bunker.usepicnic.com:8443';
afterEach(() => vi.unstubAllGlobals());
it.each([undefined, 'security-key'] as const)('passes optional %s preference without filtering authenticators', async hint => {
 class Response {}
 class Credential { response = new Response(); rawId = new Uint8Array([1]).buffer; }
 const credential = new Credential(), get = vi.fn().mockResolvedValue(credential);
 vi.stubGlobal('PublicKeyCredential', Credential);vi.stubGlobal('AuthenticatorAssertionResponse', Response);
 vi.stubGlobal('location', { origin });vi.stubGlobal('window', { isSecureContext: true });
 vi.stubGlobal('navigator', { credentials: { get } });
 const signal = new AbortController().signal;
 expect(await requestPasskey('0x1234', undefined, origin, signal, hint)).toBe(credential);
 const request = get.mock.calls[0][0];
 expect(request.signal).toBe(signal);
 expect(request.publicKey.rpId).toBe('usepicnic.com');
 expect(request.publicKey.userVerification).toBe('required');
 expect(request.publicKey.hints).toEqual(hint ? ['security-key'] : undefined);
 expect(request.publicKey.allowCredentials).toBeUndefined();
 expect(request.publicKey.authenticatorAttachment).toBeUndefined();
 await requestPasskey('0x1234', 'AQ', origin, signal, hint);
 expect(get.mock.calls[1][0].publicKey.allowCredentials).toEqual([{type:'public-key',id:new Uint8Array([1])}]);
});
