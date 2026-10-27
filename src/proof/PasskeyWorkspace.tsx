import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { chainById } from "../catalog/chains";
import { publicClient, same } from "../core/client";
import { knownGuardians, destinationError } from "../core/destination";
import { AssetTable } from "../components/AssetTable";
import { PrepareMigration } from "../components/PrepareMigration";
import { useDiagnosis, rpcFor, type RpcOverrides } from "../components/useDiagnosis";
import { useBasketContents } from "../components/useBasketContents";
import { batchSources, commitSelection, emptySelection, migrationItems, selectedIds, setSelected } from "../components/migration";
import { batchPartAction, includedEntries, planBatch, readBatchFacts, screenAssetTransfers, type BatchPlan } from "../core/batch";
import { findMultiSend } from "../core/multisend";
import { ChainLogo } from "../components/ChainLogo";
import { GasWalletConnection, useProofWallet } from "./WalletConnection";
import { assertionFrom, encodeAssertion, requestPasskey } from "./passkey";
import { diagnose, prepareActionSimulation, simulateAction, simulationChallenge } from "./simulation";
import { verifyDiscoveredAccount } from "./discoverAccounts";
import type { PasskeyProof, PublicCoordinates } from "./passkeyDiscovery";
import { runtime } from "./runtime";
import "../style.css";
import "../recovery.css";
import "./workspace.css";

type Identity = { key: PublicCoordinates; proof: PasskeyProof };
type Review = { key: string; plan: BatchPlan; simulated: number[] };
export default function PasskeyWorkspace({ account, identity, leave }: { account: Address; identity: Identity; leave: () => void }) {
  const wallet = useProofWallet();
  const [step, setStep] = useState(0);
  const [overrides] = useState<RpcOverrides>({});
  const diagnosis = useDiagnosis(account, overrides);
  // One hook instance for all three steps: expanding/navigating never reloads baskets.
  const baskets = useBasketContents(diagnosis.account, diagnosis.results, overrides);
  const items = migrationItems(diagnosis.results, diagnosis.customTokens, baskets.contents);
  const [selection, setSelection] = useState(() => emptySelection(account));
  const chosen = selectedIds(selection, items);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const running = useRef(false), mounted = useRef(true);
  const [authority, setAuthority] = useState<Record<number, Address>>({});
  const authorityRequests = useRef(new Map<number, string>());
  const [accessErrors, setAccessErrors] = useState<Record<number, string>>({});
  const [reviews, setReviews] = useState<Record<number, Review>>({});
  const guardians = knownGuardians(diagnosis.results.map(result => result.snapshot), account);
  const fingerprint = diagnosis.results.map(result => `${result.chainId}:${result.snapshot?.block ?? ""}`).join("|");
  useEffect(() => {
    for (const result of diagnosis.results) if (result.snapshot && result.snapshot.version !== "EOA") {
      const request = `${account}:${result.snapshot.block}:${identity.key.x}:${identity.key.y}:${identity.proof.challenge}`;
      if (authorityRequests.current.get(result.chainId) === request) continue;
      authorityRequests.current.set(result.chainId, request);
      const currentRequest = () => mounted.current && authorityRequests.current.get(result.chainId) === request;
      const client = publicClient(chainById(result.chainId), rpcFor(result.chainId, overrides));
      void (async () => {
        try {
          const current = await diagnose(client, account, result.chainId);
          const owner = current.signers.find(signer => signer.x === identity.key.x && signer.y === identity.key.y);
          if (!owner) throw new Error("Esta passkey não controla a conta nesta rede.");
          await verifyDiscoveredAccount(client, account, result.chainId, owner.address, identity.key, identity.proof, runtime.origin);
          if (currentRequest()) { setAuthority(old => ({ ...old, [result.chainId]: owner.address })); setAccessErrors(old => ({ ...old, [result.chainId]: "" })); }
        } catch {
          if (currentRequest()) { setAuthority(old => { const next = { ...old }; delete next[result.chainId]; return next; }); setAccessErrors(old => ({ ...old, [result.chainId]: "A passkey não pôde ser verificada nesta rede. Atualize a consulta ou use a carteira que controla essa conta." })); }
        }
      })();
    }
  }, [account, fingerprint, identity.key.x, identity.key.y, identity.proof, overrides]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const activeKey = JSON.stringify([account, wallet.address, destination, [...chosen].sort(), guardians]);
  const latest = useRef(activeKey); latest.current = activeKey;
  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy("Preparando…"); setError("");
    try { await task(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Não foi possível concluir."); }
    finally { running.current = false; if (mounted.current) setBusy(""); }
  }
  async function prepare(id: number) {
    const key = activeKey;
    if (destinationError(destination, account, wallet.address, guardians)) throw new Error("Confira o destino da migração.");
    const client = publicClient(chainById(id), rpcFor(id, overrides));
    setBusy("Atualizando saldos e verificando as rotas de cada ativo…");
    const current = await diagnose(client, account, id);
    const owner = current.signers.find(signer => signer.x === identity.key.x && signer.y === identity.key.y);
    if (!owner) throw new Error("A passkey não controla esta rede.");
    await verifyDiscoveredAccount(client, account, id, owner.address, identity.key, identity.proof, runtime.origin);
    const sources = batchSources(items.filter(item => chosen.has(item.id)), id);
    const multisend = (await findMultiSend(client, id))?.address;
    const facts = await readBatchFacts(client, current.snapshot, sources, chainById(id).contracts?.multicall3?.address);
    const initial = planBatch({ snapshot: current.snapshot, destination, facts, multisend, guardians });
    // Pre-screen route execution using a current Safe owner as eth_call sender.
    // This is not passkey authentication: each final batch uses a real assertion.
    const screened = await screenAssetTransfers(client, current.snapshot, facts, initial.destination, owner.address, multisend);
    const plan = planBatch({ snapshot: current.snapshot, destination, facts: screened, multisend, guardians });
    if (latest.current !== key || !mounted.current) throw new Error("A seleção mudou. Prepare o lote novamente.");
    setReviews(old => ({ ...old, [id]: { key, plan, simulated: [] } }));
  }
  async function simulate(id: number, part: number) {
    const review = reviews[id], key = activeKey;
    if (!review || review.key !== key) throw new Error("Prepare os lotes novamente.");
    const payer = await wallet.readAccount();
    const client = publicClient(chainById(id), rpcFor(id, overrides));
    const current = await diagnose(client, account, id);
    const owner = current.signers.find(signer => signer.x === identity.key.x && signer.y === identity.key.y);
    if (!owner) throw new Error("A passkey não controla esta conta.");
    const sources = batchSources(items.filter(item => chosen.has(item.id)), id);
    const action = batchPartAction({ snapshot: current.snapshot, plan: review.plan, part, label: "Simulação de migração", forbiddenRecipients: guardians,
      reread: () => readBatchFacts(client, current.snapshot, sources, chainById(id).contracts?.multicall3?.address) });
    const plan = await prepareActionSimulation(client, current, owner.address, action, payer);
    if (latest.current !== key) throw new Error("A seleção mudou. Prepare novamente.");
    setBusy(`Confirme a passkey para simular o lote ${part + 1}…`);
    const challenge = simulationChallenge(plan);
    const credential = await requestPasskey(challenge, identity.proof.credentialId, runtime.origin);
    const signature = await encodeAssertion(assertionFrom(credential), challenge, identity.key, runtime.origin);
    await wallet.readAccount(payer);
    if (latest.current !== key || !mounted.current) throw new Error("O destino ou a carteira mudou. Simulação interrompida.");
    setBusy("Simulando a execução completa do lote…");
    await simulateAction(client, plan, signature);
    await wallet.readAccount(payer);
    if (latest.current === key && mounted.current) setReviews(old => ({ ...old, [id]: { ...review, simulated: [...new Set([...review.simulated, part])] } }));
  }
  const scanning = diagnosis.results.some(r => r.status === "queued" || r.status === "scanning");
  const networks = [...new Set(items.filter(item => chosen.has(item.id)).map(item => item.chainId))];
  return <main className="bunker-workspace">
    <header><strong>picnic <span>bunker</span></strong><button disabled={!!busy} className="quiet" onClick={leave}>Trocar conta</button></header>
    <nav className="bunker-steps" aria-label="Etapas">{["Diagnóstico", "Preparar carteiras", "Simular migração"].map((label, index) => <button key={label} aria-current={step === index ? "step" : undefined} disabled={!!busy || index > step} onClick={() => setStep(index)}>{index + 1}. {label}</button>)}</nav>
    <p className="small">Safe <code>{account}</code> · acesso por passkey · execução local</p>
    {step === 0 && <section className="panel"><h1>Seus ativos, em todas as redes.</h1><div className="row"><strong>{items.length} ativos encontrados</strong><span>{diagnosis.results.filter(r => r.status !== "queued" && r.status !== "scanning").length} / {diagnosis.results.length} redes consultadas</span></div>
      <progress value={diagnosis.results.filter(r => r.status !== "queued" && r.status !== "scanning").length} max={diagnosis.results.length || 1}/>
      <button disabled={scanning || !!busy || !items.length} onClick={() => setStep(1)}>{scanning ? "Consultando as redes…" : "Preparar carteiras"}</button>
      <details><summary>Ver ativos e conteúdo das cestas</summary><AssetTable lang="pt" busy={!!busy} ready={!!diagnosis.results.length} results={diagnosis.results} custom={diagnosis.customTokens} open={() => {}} showActions={false} baskets={baskets} addCustom={diagnosis.addCustomToken} removeCustom={diagnosis.removeCustomToken} retryCustom={diagnosis.retryCustomToken}/></details>
      <details><summary>Pendências e cobertura da consulta</summary>{diagnosis.results.filter(r => r.issues.length || accessErrors[r.chainId]).map(result => <div key={result.chainId}><strong>{chainById(result.chainId).name}</strong><p>{accessErrors[result.chainId]}</p>{result.issues.map((issue, i) => <p key={i}>{issue}</p>)}<button disabled={scanning || !!busy} onClick={() => diagnosis.retryPending(result.chainId)}>Tentar concluir</button></div>)}<p>Ativos fora do catálogo podem ser adicionados como tokens. Consultas parciais não significam saldo zero.</p></details>
    </section>}
    {step === 1 && <><GasWalletConnection/><PrepareMigration authority={authority} simulation lang="pt" busy={!!busy} account={account} wallet={wallet.address} results={diagnosis.results} items={items} selection={selection} select={(ids, value) => setSelection(old => setSelected(old, items, ids, value))} overrides={overrides} destination={destination} setDestination={setDestination} rescan={diagnosis.rescan} addCustom={diagnosis.addCustomToken} retryCustom={diagnosis.retryCustomToken} run={run} connect={() => document.querySelector<HTMLElement>(".gas-wallet button")?.focus()} guardians={guardians} retryBasket={id => baskets.retry([id])} next={() => { setSelection(old => commitSelection(old, items)); setStep(2); }}/></>}
    {step === 2 && <section className="panel"><h2>Simular os lotes da migração</h2><p>Destino: <code>{destination}</code>. Nada será enviado à blockchain. Cada lote é simulado separadamente; ativos não são marcados como migrados.</p>
      {networks.map(id => {
        const stored = reviews[id], review = stored?.key === activeKey ? stored : undefined;
        return <article key={id} className="bunker-network"><h3><ChainLogo id={id}/> {chainById(id).name}</h3><button disabled={!!busy || !wallet.address || !authority[id]} onClick={() => void run(() => prepare(id))}>Preparar lotes</button>
          {review && <><p>{review.simulated.length} de {review.plan.parts.length} lotes simulados</p><progress value={review.simulated.length} max={review.plan.parts.length || 1}/>{review.plan.parts.map((ids, index) => <div className="bunker-batch" key={index}><strong>Lote {index + 1} · {ids.length} ativos</strong><details><summary>Ver ativos</summary>{includedEntries(review.plan, index).map(entry => <p key={entry.id}>{entry.label} · {entry.outcome === "queued" ? "entrada na fila do cartão; liberação após o prazo on-chain" : entry.outcome === "basket" ? "retirar BRL e transferir a cesta" : "transferência/resgate"}</p>)}</details><button disabled={!!busy || review.simulated.includes(index)} onClick={() => void run(() => simulate(id, index))}>{review.simulated.includes(index) ? "Simulado" : "Simular com passkey"}</button></div>)}
          {review.plan.entries.filter(entry => entry.status !== "included" || entry.later.length).map(entry => <p className="small" key={entry.id}>{entry.label}: {entry.status === "empty" ? "sem saldo atual" : entry.transferBlocked ? "transferência reverteu; fica fora do lote" : "exige uma etapa posterior"}. {[...entry.notes, ...entry.later].join(" ")}</p>)}{review.plan.unavailable && <p className="error">Lotes indisponíveis nesta rede: {review.plan.unavailable}.</p>}</>}
        </article>;
      })}
    </section>}
    {busy && <div role="status" className="status"><progress/>{busy}</div>}{error && <p role="alert" className="error">{error}</p>}
  </main>;
}
