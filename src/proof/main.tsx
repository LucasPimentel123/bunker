import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, toHex } from "viem";
import { assertionFrom, base64url, encodeAssertion, requestPasskey } from "./passkey";
import { parseAmount, publicClient } from "../core/client";
import { chainById } from "../catalog/chains";
import { diagnose, prepareSimulation, simulateWithdrawal, simulationChallenge, verifyOnChain, type Diagnosis } from "./simulation";
import "./style.css";
import { runtime } from "./runtime";
import { discoveryChallenge, identifyPasskey, type PasskeyProof } from "./passkeyDiscovery";
import { verifyDiscoveredAccount, type DiscoveryNetwork, type DiscoveredAccount } from "./discoverAccounts";
import { discoverCandidateAccounts, keyId, resolveDiscovery, startDiscovery, type DiscoverySession } from "./discoveryFlow";
import { ProofWalletProvider, useProofWallet } from "./WalletConnection";
import { WithdrawalForm } from "./WithdrawalForm";
import { discoveryRpc, independentAccountHints } from "../core/ownerHistory";
const ExternalBunker = lazy(() => import("./ExternalBunker"));
const PasskeyWorkspace = lazy(() => import("./PasskeyWorkspace"));
function App() {
  const gasWallet = useProofWallet();
  const [external, setExternal] = useState(false);
  const [workspace, setWorkspace] = useState<DiscoveredAccount>();
  const running = useRef(false);
  const [session, setSession] = useState<DiscoverySession>();
  const [networks, setNetworks] = useState<DiscoveryNetwork[]>([]);
  const resolution = session ? resolveDiscovery(session, networks) : undefined;
  const identity = session && resolution?.key ? { key: resolution.key, proof: session.proof } : undefined;
  const [networkProgress, setNetworkProgress] = useState<Record<number, string>>({});
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const [safe, setSafe] = useState(() => new URLSearchParams(location.search).get("safe") ?? "");
  const [chainId, setChainId] = useState(() => {
    const requested = new URLSearchParams(location.search).get("chain") ?? "137";
    return runtime.networks && !runtime.networks.some(network => network.id === Number(requested)) ? "137" : requested;
  });
  const [diagnosis, setDiagnosis] = useState<Diagnosis>();
  const [signer, setSigner] = useState("");
  const [credentialId, setCredentialId] = useState<string>();
  const [verified, setVerified] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [payer, setPayer] = useState("");
  const [amount, setAmount] = useState("");
  const [useAll, setUseAll] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<Awaited<ReturnType<typeof simulateWithdrawal>>>();
  useEffect(() => { setReport(undefined); }, [gasWallet.address, gasWallet.status]);
  async function run(label: string, fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(label); setError("");
    try { await fn(); } catch (e) { setError(e instanceof DOMException && e.name === "NotAllowedError" ? "A passkey não foi selecionada. Tente novamente e escolha o dispositivo onde ela está salva." : e instanceof Error ? e.message : String(e)); }
    finally { running.current = false; setBusy(""); }
  }
  function reset() { setDiagnosis(undefined); setVerified(false); setCredentialId(undefined); setReport(undefined); }
  async function beginDiscovery() {
    setWorkspace(undefined); reset(); setRecipient(""); setPayer(""); setAmount(""); setUseAll(true); setSession(undefined); setNetworks([]); setNetworkProgress({}); setCompleted(0); setTotal(0);
    runtime.assertContext();
    const challenge = discoveryChallenge();
    const credential = await requestPasskey(challenge, undefined, runtime.origin);
    const proof: PasskeyProof = { challenge, credentialId: base64url(new Uint8Array(credential.rawId)), assertion: assertionFrom(credential) };
    const found = startDiscovery(proof, runtime.origin);
    setSession(found); setBusy("Passkey recebida. Buscando suas contas…");
    await scanNetworks(found);
  }
  async function scanNetworks(found: DiscoverySession, ids = runtime.networks!.map(network => network.id)) {
    reset();
    setCompleted(0); setTotal(ids.length);
    await Promise.all(ids.map(async id => {
      const update = (message: string) => setNetworkProgress(current => ({ ...current, [id]: message }));
      let result: DiscoveryNetwork;
      try {
        result = await discoverCandidateAccounts(runtime.client(id), id, found, runtime.origin, (chain, owner) => independentAccountHints(runtime.localBunker ? publicClient(chainById(chain), discoveryRpc(chain)) : runtime.client(chain), chain, owner, update), update);
      } catch (error) { result = { chainId: id, accounts: [], issues: [error instanceof Error ? error.message : "Consulta indisponível."] }; }
      setNetworks(current => {
        const previous = current.find(network => network.chainId === id);
        let merged = result;
        if (result.issues.length && previous) {
          const retained = previous.accounts.filter(account => (!found.confirmedKey || keyId(account.publicKey) === keyId(found.confirmedKey)) && !result.accounts.some(fresh => fresh.signer === account.signer && fresh.diagnosis.snapshot.address.toLowerCase() === account.diagnosis.snapshot.address.toLowerCase()));
          merged = { ...result, accounts: [...result.accounts, ...retained.map(account => ({ ...account, needsRevalidation: true }))] };
        }
        return [...current.filter(network => network.chainId !== id), merged];
      });
      update(result.issues.length ? "Consulta com pendências" : "Consulta concluída");
      setCompleted(value => value + 1);
    }));
  }
  async function completeDiscovery() {
    if (!session || !resolution?.needsSecondAssertion) return;
    reset();
    runtime.assertContext();
    const challenge = discoveryChallenge();
    const credential = await requestPasskey(challenge, session.proof.credentialId, runtime.origin);
    const proof = { challenge, credentialId: base64url(new Uint8Array(credential.rawId)), assertion: assertionFrom(credential) };
    const key = await identifyPasskey(session.proof, proof, runtime.origin);
    if (!resolution.matches.some(candidate => keyId(candidate) === keyId(key))) throw new Error("A chave confirmada não corresponde às contas encontradas. Repita a busca.");
    const found: DiscoverySession = { candidates: session.candidates, confirmedKey: key, proof };
    setSession(found);
    setNetworks(current => current.map(network => ({ ...network, accounts: network.accounts.filter(account => keyId(account.publicKey) === keyId(key)) })));
    setBusy("Passkey confirmada. Atualizando suas contas…");
    await scanNetworks(found);
  }
  async function selectAccount(account: DiscoveredAccount) {
    if (!identity || keyId(account.publicKey) !== keyId(identity.key)) return;
    reset();
    const { address, chainId: id } = account.diagnosis.snapshot;
    const fresh = await verifyDiscoveredAccount(runtime.client(id), address, id, account.signer, identity.key, identity.proof, runtime.origin);
    setSafe(address); setChainId(String(id)); setDiagnosis(fresh.diagnosis); setSigner(fresh.signer);
    setCredentialId(identity.proof.credentialId); setVerified(true);
    setUseAll(true); setAmount(formatEther(fresh.diagnosis.snapshot.nativeBalance));
    if (runtime.localBunker) setWorkspace(fresh);
  }
  async function check() {
    reset();
    const network = Number(chainId);
    if (!Number.isSafeInteger(network) || network <= 0) throw new Error("Chain ID inválido.");
    const client = runtime.client(network);
    const found = await diagnose(client, getAddress(safe), network);
    setDiagnosis(found); setSigner(found.signers[0].address);
    setUseAll(true); setAmount(formatEther(found.snapshot.nativeBalance));
  }
  async function authenticate() {
    if (!diagnosis) return;
    setVerified(false); setReport(undefined);
    runtime.assertContext();
    const client = runtime.client(diagnosis.snapshot.chainId);
    const challenge = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const selected = diagnosis.signers.find(s => s.address === signer)!;
    const credential = await requestPasskey(challenge, undefined, runtime.origin);
    const signature = await encodeAssertion(assertionFrom(credential), challenge, selected, runtime.origin);
    await verifyOnChain(client, selected.address, challenge, signature, diagnosis.snapshot.block);
    setCredentialId(base64url(new Uint8Array(credential.rawId))); setVerified(true);
  }
  async function simulate() {
    if (!diagnosis || !verified || !credentialId) return;
    setReport(undefined);
    runtime.assertContext();
    const client = runtime.client(diagnosis.snapshot.chainId);
    const fresh = await diagnose(client, diagnosis.snapshot.address, diagnosis.snapshot.chainId);
    const selected = fresh.signers.find(s => s.address === signer);
    if (!selected) throw new Error("A propriedade da Safe mudou. Consulte a conta novamente.");
    const connectedPayer = runtime.localBunker ? await gasWallet.readAccount() : getAddress(payer);
    const plan = await prepareSimulation(client, fresh, selected.address, { recipient: getAddress(recipient), payer: connectedPayer, amount: useAll ? fresh.snapshot.nativeBalance : parseAmount(amount, 18) });
    setDiagnosis(fresh);
    setBusy("Confirme a passkey para a simulação…");
    const challenge = simulationChallenge(plan);
    const credential = await requestPasskey(challenge, credentialId, runtime.origin);
    const signature = await encodeAssertion(assertionFrom(credential), challenge, selected, runtime.origin);
    if (runtime.localBunker) await gasWallet.readAccount(connectedPayer);
    setBusy("Validando a execução completa da Safe…");
    const result = await simulateWithdrawal(client, plan, signature);
    if (runtime.localBunker) await gasWallet.readAccount(connectedPayer);
    setReport(result);
  }
  if (runtime.localBunker && external) return <Suspense fallback={<p role="status">Abrindo Bunker…</p>}><ExternalBunker leave={() => setExternal(false)}/></Suspense>;
  if (runtime.localBunker && workspace && identity) return <Suspense fallback={<p role="status">Abrindo seus ativos…</p>}><PasskeyWorkspace key={`${workspace.diagnosis.snapshot.address}:${identity.proof.challenge}`} account={workspace.diagnosis.snapshot.address} identity={identity} leave={() => setWorkspace(undefined)}/></Suspense>;
  return <main className="proof-entry">
    <header><strong>picnic <span>{runtime.discovery ? "bunker" : "recovery"}</span></strong><span>{runtime.extension ? "Extensão passkeys · experimental" : runtime.localBunker ? "Bunker local · experimental" : "Prova local · somente simulação"}</span></header>
    <h1>{runtime.localBunker ? "Seu acesso. Independente." : "Sua passkey. Seu acesso."}</h1>
    {runtime.localBunker && !session && <section><h2>Como você acessa sua conta?</h2><p>Escolha sua passkey abaixo ou conecte a carteira que controla sua conta. Se você precisa recuperar o acesso, conecte seu guardian pela opção de carteira externa.</p><button className="secondary" onClick={() => setExternal(true)}>Continuar com carteira externa</button></section>}
    <p>{runtime.localBunker ? "Acesse sua conta e consulte seus ativos sem os servidores da Picnic. A entrada por passkey permite simular os lotes; a carteira externa também oferece migração e recuperação por guardian." : "Teste uma passkey existente sem os servidores da Picnic. Este protótipo simula uma retirada da moeda nativa em uma rede por vez."}</p>
    <aside>{runtime.localBunker ? "A interface é servida pelo seu computador. A descoberta consulta o índice público da Safe e RPCs independentes. Nenhum servidor da Picnic é usado." : runtime.extension ? "A interface roda dentro da extensão. Os endereços são localizados pelo índice público da Safe e o controle é validado em RPCs públicos; nenhum servidor da Picnic é usado. Sua passkey continua no provedor do dispositivo." : "O navegador só acessa este servidor local. As leituras da blockchain passam por um RPC independente. O uso de uma passkey sincronizada ainda pode depender do provedor do dispositivo."}</aside>
    <fieldset disabled={!!busy}>
      {runtime.discovery ? <section>
        <h2>1. Encontrar minhas contas</h2>
        <p>Use sua passkey Picnic. Não é necessário informar o endereço da Safe.</p>
        <p className="subtle">Confirme sua passkey uma vez. Vamos buscar as contas e verificar o vínculo na blockchain. Essa assinatura não autoriza uma movimentação.</p>
        <button onClick={() => run("Escolha sua passkey…", beginDiscovery)}>{session ? "Escolher outra passkey" : "Continuar com passkey"}</button>
        {session && <>
          {resolution?.needsSecondAssertion && <div role="status"><p>Encontramos Safes on-chain vinculadas a mais de uma chave candidata. Confirme a mesma passkey para distinguir qual é a sua.</p>
            <button onClick={() => run("Confirme a mesma passkey para distinguir as contas…", completeDiscovery)}>Confirmar minha passkey</button>
          </div>}
          <p className={identity ? "success" : "subtle"}>{identity ? "Conta encontrada e vínculo com a passkey verificado on-chain." : resolution?.needsSecondAssertion ? "É necessária uma confirmação adicional para distinguir as contas encontradas." : completed < total ? "Passkey recebida. Buscando suas contas sem novas assinaturas…" : "Nenhuma conta confirmada. Você pode repetir a busca sem assinar novamente."}</p>
          <progress value={completed} max={total || 1} aria-label="Redes consultadas"/>
          <p>{completed} de {total} redes consultadas</p>
          {runtime.networks!.map(network => {
            const result = networks.find(value => value.chainId === network.id);
            return <div key={network.id}><strong>{network.name}</strong> · {networkProgress[network.id] ?? "Na fila"}
              {result?.accounts.filter(account => !session.confirmedKey || keyId(account.publicKey) === keyId(session.confirmedKey)).map(account => <div key={`${account.signer}:${account.diagnosis.snapshot.address}`} className="success">
                <p>Safe <code>{account.diagnosis.snapshot.address}</code></p>
                <p className="subtle">Signer passkey: <code>{account.signer}</code> · {account.needsRevalidation ? "resultado anterior; será revalidado ao selecionar" : "propriedade confirmada on-chain"}</p>
                <button disabled={!identity} onClick={() => run("Atualizando o controle da conta…", () => selectAccount(account))}>{runtime.localBunker ? "Ver ativos desta conta" : "Usar esta conta para simular"}</button>
              </div>)}
              {result && !result.accounts.length && <p>Nenhuma conta confirmada nesta consulta. Isso não garante que não existam contas nesta rede.</p>}
              {result?.issues.map((issue, index) => <p className="error" key={index}>{issue}</p>)}
              {result && (!!result.issues.length || !result.accounts.length) && <button onClick={() => run("Repetindo a consulta pendente…", () => scanNetworks(session, [network.id]))}>Repetir {network.name}</button>}
            </div>;
          })}
          <p className="subtle">Cobertura desta prova: Polygon, Gnosis e Ethereum; signers WebAuthn 0.2.0/0.2.1 e Safes com threshold 1. O índice da Safe pode estar incompleto ou indisponível. A identificação não usa e-mail, userHandle nem banco da Picnic.</p>
        </>}
      </section> : <>
      <section><h2>1. Identificar a Safe e o signer</h2>
        <label>Endereço público da Safe<input value={safe} onChange={e => { setSafe(e.target.value); reset(); }} placeholder="0x…" spellCheck={false}/></label>
        {runtime.networks ? <label>Rede<select value={chainId} onChange={e => { setChainId(e.target.value); reset(); }}>{runtime.networks.map(network => <option key={network.id} value={network.id}>{network.name}</option>)}</select></label> : <label>Chain ID<input value={chainId} onChange={e => { setChainId(e.target.value); reset(); }} inputMode="numeric"/></label>}
        <button onClick={() => run("Consultando a blockchain…", check)}>Consultar Safe</button>
        {diagnosis && <div className="success">Safe {diagnosis.snapshot.version} · bloco {String(diagnosis.snapshot.block)} · {diagnosis.signers.length} signer(s) passkey
          <label>Signer on-chain<select value={signer} onChange={e => { setSigner(e.target.value); setVerified(false); setCredentialId(undefined); setReport(undefined); }}>{diagnosis.signers.map(s => <option key={s.address} value={s.address}>{s.address} · WebAuthn {s.version}</option>)}</select></label>
        </div>}
      </section>
      <section><h2>2. Validar a passkey existente</h2><p>Escolha sua passkey no dispositivo. Não vamos criar uma credencial nova.</p>
        <button disabled={!diagnosis} onClick={() => run("Escolha a passkey no dispositivo…", authenticate)}>Validar passkey</button>
        {verified && <p className="success">Assinatura validada contra a chave pública e o contrato on-chain.</p>}
      </section>
      </>}
      {verified && diagnosis && <WithdrawalForm diagnosis={diagnosis} recipient={recipient} setRecipient={value => { setRecipient(value); setReport(undefined); }}
        payer={payer} setPayer={value => { setPayer(value); setReport(undefined); }} amount={amount} setAmount={value => { setAmount(value); setReport(undefined); }}
        useAll={useAll} setUseAll={value => { setUseAll(value); setReport(undefined); }} simulate={() => run("Preparando a simulação…", simulate)}/>}
    </fieldset>
    {busy && <div role="status" className="status"><progress aria-label={busy}/><p>{busy}</p></div>}
    {error && <p role="alert" className="error">{error}</p>}
    {report && <section className="success" role="status"><h2>Simulação concluída</h2><p>A Safe aceitou sua passkey e a retirada de <strong>{formatEther(BigInt(report.amount))} {runtime.networks?.find(network => network.id === report.chainId)?.symbol ?? "moeda nativa"}</strong> passou na simulação.</p><p>Destino: <code>{report.recipient}</code></p><p>Nenhum dinheiro foi movimentado e nenhum gás foi gasto.</p><details><summary>Ver detalhes técnicos</summary><pre>{JSON.stringify(report, null, 2)}</pre></details></section>}
    <footer>{runtime.localBunker ? "Sem coleta de chaves privadas. Toda movimentação exige sua confirmação na carteira." : "Sem coleta de chaves privadas. Sem assinatura automática. Sem envio de transações."}</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<ProofWalletProvider><App/></ProofWalletProvider>);
