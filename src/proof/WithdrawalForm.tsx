import { useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import type { Diagnosis } from "./simulation";
import { GasWalletConnection, useProofWallet } from "./WalletConnection";
import { runtime } from "./runtime";
import { destinationError } from "./withdrawalWallet";

function GasBalance({ address, chainId, symbol }: { address?: Address; chainId: number; symbol: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; balance?: bigint; error?: string }>();
  const key = `${chainId}:${address}:${attempt}`;
  useEffect(() => {
    if (!address) return;
    let disposed = false;
    const client = runtime.client(chainId);
    void Promise.all([client.getBalance({ address }), client.getCode({ address })]).then(([balance, code]) => {
      if (!disposed) setResult({ key, balance, error: code && code !== "0x" ? "Esta prova aceita apenas uma carteira EOA como pagador. Conecte outra conta." : undefined });
    }).catch(() => { if (!disposed) setResult({ key, error: "Não foi possível consultar o saldo para taxas." }); });
    return () => { disposed = true; };
  }, [address, chainId, key]);
  if (!address) return null;
  const current = result?.key === key ? result : undefined;
  if (!current) return <p role="status">Consultando saldo para taxas…</p>;
  if (current.error) return <div><p className="error" role="alert">{current.error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>Consultar novamente</button></div>;
  return <p className="subtle">Saldo para taxas nesta rede: <strong>{formatEther(current.balance!)} {symbol}</strong>.
    {current.balance === 0n ? " Para enviar uma retirada real, será necessário adicionar saldo aqui. A simulação não gasta gás." : " Nenhum gás será gasto nesta simulação."}</p>;
}
export function WithdrawalForm({ diagnosis, recipient, setRecipient, payer, setPayer, amount, setAmount, useAll, setUseAll, simulate }: {
  diagnosis: Diagnosis; recipient: string; setRecipient: (value: string) => void; payer: string; setPayer: (value: string) => void;
  amount: string; setAmount: (value: string) => void; useAll: boolean; setUseAll: (value: boolean) => void; simulate: () => void;
}) {
  const wallet = useProofWallet();
  const network = runtime.networks?.find(network => network.id === diagnosis.snapshot.chainId);
  const symbol = network?.symbol ?? "moeda nativa";
  const invalidDestination = destinationError(diagnosis.snapshot, recipient);
  return <section className="withdrawal">
    <h2>{runtime.discovery ? "2" : "3"}. Preparar a retirada</h2>
    <div className="withdrawal-summary"><div><span className="subtle">{network?.name ?? `Rede ${diagnosis.snapshot.chainId}`}</span><p className="withdrawal-balance">{formatEther(diagnosis.snapshot.nativeBalance)} <span>{symbol}</span></p></div>
      <div><span className="subtle">Conta de origem</span><p><code>{diagnosis.snapshot.address}</code></p></div></div>
    {runtime.localBunker ? <><GasWalletConnection/><GasBalance address={wallet.address} chainId={diagnosis.snapshot.chainId} symbol={symbol}/></> :
      <label>Endereço da carteira externa para simular o pagamento das taxas<input value={payer} onChange={e => setPayer(e.target.value)} placeholder="0x…" spellCheck={false}/></label>}
    <label>Para onde você quer retirar?<input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Endereço da carteira de destino · 0x…" spellCheck={false} aria-invalid={!!invalidDestination} aria-describedby={invalidDestination ? "destination-error" : undefined}/></label>
    {invalidDestination && <p id="destination-error" role="alert" className="error">{invalidDestination}</p>}
    <label className="all-balance"><input type="checkbox" checked={useAll} onChange={e => setUseAll(e.target.checked)}/>Todo o saldo disponível</label>
    {!useAll && <label>Quanto retirar ({symbol})<input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal"/></label>}
    <button disabled={!!invalidDestination || !recipient || (runtime.localBunker ? wallet.status !== "ready" : !payer) || (!useAll && !amount) || diagnosis.snapshot.nativeBalance === 0n} onClick={simulate}>Simular retirada</button>
    <p className="subtle">Você confirma a operação com sua passkey. Esta prova só simula: não envia a transação nem movimenta fundos.</p>
    <details><summary>Detalhes da simulação</summary><p className="subtle">A simulação retira apenas {symbol} desta Safe. A carteira externa seria responsável pelas taxas de uma retirada real. O nonce reservado à simulação impede usar esta assinatura no nonce atual; saldo, owners e contratos não são alterados.</p></details>
  </section>;
}
