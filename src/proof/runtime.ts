import { createPublicClient, http } from "viem";
import { extensionClient, extensionNetworks } from "../extension/transport";
import { EXTENSION_ORIGIN, verifyExtensionContext } from "../extension/context";
import { BUNKER_ORIGIN, assertLocalBunker } from "./localBunker";
import { PROOF_ORIGIN } from "./passkey";

// Fixed by the build, never selected by URL, RPC response or imported metadata.
declare const __PASSKEY_EXTENSION__: boolean;
declare const __PASSKEY_LOCAL_BUNKER__: boolean;
const localBunker = typeof __PASSKEY_LOCAL_BUNKER__ !== "undefined" && __PASSKEY_LOCAL_BUNKER__;
const extension = typeof __PASSKEY_EXTENSION__ !== "undefined" && __PASSKEY_EXTENSION__;
export const runtime = {
  extension, localBunker, discovery: extension || localBunker,
  origin: extension ? EXTENSION_ORIGIN : localBunker ? BUNKER_ORIGIN : PROOF_ORIGIN,
  networks: extension || localBunker ? extensionNetworks : undefined,
  assertContext: () => { if (extension) verifyExtensionContext(); else if (localBunker) assertLocalBunker(location.origin, window.isSecureContext); },
  client: (chainId: number) => {
    if (extension) { verifyExtensionContext(); return extensionClient(chainId); }
    if (localBunker) { assertLocalBunker(location.origin, window.isSecureContext); return extensionClient(chainId); }
    return createPublicClient({ ccipRead: false, transport: http("/rpc", { retryCount: 0, timeout: 35_000 }) });
  },
};
