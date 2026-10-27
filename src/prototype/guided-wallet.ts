import EthereumProvider from '@walletconnect/ethereum-provider';
import QRCode from 'qrcode/lib/browser.js';
import { chains, defaultReadRpcs } from '../catalog/chains';
import { assertLocalBunker } from '../proof/localBunker';

export async function connectQrWallet(signal: AbortSignal, show: (uri: string, image: string) => void) {
  assertLocalBunker(location.origin, window.isSecureContext);
  signal.throwIfAborted();
  const provider = await EthereumProvider.init({
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'dd53d0734789440eeeea6f8c1064b66b',
    optionalChains: chains.map(c => c.id) as [number, ...number[]],
    optionalMethods: ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain'],
    showQrModal: false, telemetryEnabled: false, disableProviderPing: true, logger: 'silent',
    rpcMap: Object.fromEntries(chains.map(c => [c.id, defaultReadRpcs(c)[0]])),
    metadata: { name: 'Picnic Bunker', description: 'Recupere o acesso à sua conta Picnic.', url: location.origin, icons: [] },
  });
  if (provider.session) await provider.disconnect();
  const close = () => { void provider.disconnect().catch(() => {}); };
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  let finished = false, qrFailure: ((reason: Error) => void) | undefined;
  const qrError = new Promise<never>((_, reject) => { qrFailure = reject; });
  const uriListener = (uri: string) => {
    if (!uri.startsWith('wc:')) return;
    void QRCode.toDataURL(uri, { width: 288, margin: 3, errorCorrectionLevel: 'M' }).then(image => {
      if (!signal.aborted && !finished) show(uri, image);
    }).catch(() => { if (!finished && !signal.aborted) qrFailure?.(Error('Não foi possível gerar o QR code. Tente novamente.')); });
  };
  provider.on('display_uri', uriListener);
  let aborted: (() => void) | undefined;
  try {
    await Promise.race([qrError, provider.connect().then(() => { if (signal.aborted) close(); }), new Promise<never>((_, reject) => {
      aborted = () => { close(); reject(signal.reason ?? Error('Conexão cancelada.')); };
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    })]);
    signal.throwIfAborted();
    return provider;
  } catch (error) { close(); throw error; }
  finally { finished = true; provider.removeListener('display_uri', uriListener); if (aborted) signal.removeEventListener('abort', aborted); }
}
