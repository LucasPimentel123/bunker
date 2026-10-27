import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { createConfig, useAccount, useConnect, useDisconnect, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mainnet, polygon, gnosis } from "viem/chains";
import { custom, http, type Address, type Chain, type EIP1193Provider } from "viem";
import { chains, defaultReadRpcs } from "../catalog/chains";
import { useLiveWallet } from "../components/useLiveWallet";
import { readOnlyProvider } from "../extension/transport";
import { readPayerAccount } from "./withdrawalWallet";
import { runtime } from "./runtime";

// Local-only connector discovery. No relay, remote wallet catalog, persistent
// session, chain switch, signature request or transaction is needed to connect.
const config = createConfig({
  chains: runtime.localBunker ? chains as readonly [Chain, ...Chain[]] : [polygon, gnosis, mainnet], connectors: [injected()],
  multiInjectedProviderDiscovery: true, storage: null,
  transports: runtime.localBunker
    ? Object.fromEntries(chains.map(chain => [chain.id, http(defaultReadRpcs(chain)[0], { retryCount: 0 })]))
    : { 137: custom(readOnlyProvider(137)), 100: custom(readOnlyProvider(100)), 1: custom(readOnlyProvider(1)) },
});
type WalletState = { address?: Address; status: string; readAccount: (expected?: Address) => Promise<Address> };
const WalletContext = createContext<WalletState | undefined>(undefined);
function LiveWallet({ children }: { children: ReactNode }) {
  const connection = useAccount();
  const live = useLiveWallet(connection);
  const current = useRef({ connection, live }); current.current = { connection, live };
  async function readAccount(expected?: Address) {
    const before = current.current;
    if (!before.connection.connector || before.live.status !== "ready") throw new Error("Conecte a carteira que pagará as taxas.");
    const provider = await before.connection.connector.getProvider() as EIP1193Provider;
    const address = await readPayerAccount(provider, expected ?? before.live.address);
    const after = current.current;
    if (after.connection.connector?.uid !== before.connection.connector.uid || after.live.address?.toLowerCase() !== address.toLowerCase()) throw new Error("A carteira conectada mudou. Confira o pagador e tente novamente.");
    return address;
  }
  return <WalletContext.Provider value={{ ...live, readAccount }}>{children}</WalletContext.Provider>;
}
export function ProofWalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <WagmiProvider config={config} reconnectOnMount={false}><QueryClientProvider client={queryClient}><LiveWallet>{children}</LiveWallet></QueryClientProvider></WagmiProvider>;
}
export function useProofWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("Wallet context unavailable");
  return value;
}
export function GasWalletConnection() {
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const connection = useAccount();
  const live = useProofWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const ordered = [...connectors].sort((a, b) => Number(a.id === "injected") - Number(b.id === "injected"));
  return <div className="gas-wallet">
    <h3>Carteira para as taxas</h3>
    {connection.isConnected ? <>
      <p>{connection.connector?.name} · <code>{live.address ?? "Verificando conta selecionada…"}</code></p>
      {live.status === "error" && <p className="error" role="alert">Não foi possível confirmar a conta. Reconecte sua carteira.</p>}
      <button className="secondary" onClick={() => { disconnect(); setOpen(true); setError(""); }}>Trocar ou desconectar</button>
    </> : <>
      <p className="subtle">Conecte uma carteira externa. O endereço será preenchido automaticamente.</p>
      <button aria-expanded={open} aria-controls="gas-wallet-options" onClick={() => setOpen(value => !value)}>Conectar carteira</button>
      {open && <div id="gas-wallet-options" className="wallet-options" aria-label="Escolher carteira">
        {ordered.map(connector => <button key={connector.uid} className="secondary" disabled={isPending} onClick={async () => {
          setError("");
          try { await connectAsync({ connector }); setOpen(false); }
          catch { setError("A conexão não foi concluída. Abra sua carteira e tente novamente."); }
        }}>{connector.id === "injected" ? "Outra carteira" : connector.name}</button>)}
        {isPending && <p role="status">Confirme a conexão na sua carteira…</p>}
        <p className="subtle">Use uma extensão de carteira instalada neste navegador.</p>
      </div>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
