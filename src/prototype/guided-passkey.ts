import { assertionFrom, base64url, requestPasskey, encodeAssertion, contractSignature } from '../proof/passkey';
import { discoveryChallenge, identifyPasskey } from '../proof/passkeyDiscovery';
import { discoverCandidateAccounts, keyId, resolveDiscovery, startDiscovery, type DiscoverySession } from '../proof/discoveryFlow';
import type { DiscoveryNetwork } from '../proof/discoverAccounts';
import { BUNKER_ORIGIN, assertLocalBunker } from '../proof/localBunker';
import { publicClient } from '../core/client';
import { chainById } from '../catalog/chains';
import { discoveryRpc, independentAccountHints } from '../core/ownerHistory';
import networks from '../../extension/networks.json';

type Progress = (message: string) => void;
let pending: { session: DiscoverySession; networks: DiscoveryNetwork[]; hint?: "security-key" } | undefined;
export function resetPasskey() { pending = undefined; }
async function proof(signal: AbortSignal, credentialId?: string, hint?: "security-key") {
  assertLocalBunker(location.origin, window.isSecureContext);
  signal.throwIfAborted();
  const challenge = discoveryChallenge();
  const credential = await requestPasskey(challenge, credentialId, BUNKER_ORIGIN, signal, hint);
  signal.throwIfAborted();
  return { challenge, credentialId: base64url(new Uint8Array(credential.rawId)), assertion: assertionFrom(credential) };
}
async function lookup(session: DiscoverySession, signal: AbortSignal, progress: Progress, hint?: "security-key") {
  let done = 0;
  const results = await Promise.all(networks.map(async network => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    const client = publicClient(chainById(network.id), discoveryRpc(network.id), 20_000, bounded);
    try {
      const result = await discoverCandidateAccounts(client, network.id, session, BUNKER_ORIGIN,
        (id, owner) => independentAccountHints(publicClient(chainById(id), discoveryRpc(id), 20_000, bounded), id, owner));
      bounded.throwIfAborted();
      return result;
    } catch { signal.throwIfAborted(); return { chainId: network.id, accounts: [], issues: [`${network.name}: descoberta incompleta.`] }; }
    finally { if (!signal.aborted) progress(`Passkey recebida · ${++done} de ${networks.length} redes verificadas`); }
  }));
  signal.throwIfAborted();
  const resolution = resolveDiscovery(session, results);
  pending = { session, networks: results, hint };
  const accounts = resolution.key ? results.flatMap(n => n.accounts).filter(a => keyId(a.publicKey) === keyId(resolution.key!)) : [];
  return { addresses: [...new Set(accounts.map(a => a.diagnosis.snapshot.address))], issues: results.flatMap(n => n.issues), needsSecond: resolution.needsSecondAssertion };
}
export async function discoverPasskey(signal: AbortSignal, progress: Progress, hint?: "security-key") {
  pending = undefined;
  progress('Confirme a passkey no seu dispositivo. Isso identifica a conta; não autoriza uma retirada.');
  const session = startDiscovery(await proof(signal, undefined, hint), BUNKER_ORIGIN);
  progress('Passkey recebida. Verificando sua conta na blockchain…');
  return lookup(session, signal, progress, hint);
}
export async function confirmPasskey(signal: AbortSignal, progress: Progress) {
  const previous = pending;
  if (!previous || !resolveDiscovery(previous.session, previous.networks).needsSecondAssertion) throw new Error('Repita a identificação da passkey.');
  const second = await proof(signal, previous.session.proof.credentialId, previous.hint);
  const key = await identifyPasskey(previous.session.proof, second, BUNKER_ORIGIN);
  if (!resolveDiscovery(previous.session, previous.networks).matches.some(k => keyId(k) === keyId(key))) throw new Error('A passkey não corresponde às contas encontradas.');
  return lookup({ ...previous.session, proof: second, confirmedKey: key }, signal, progress, previous.hint);
}

// Captured identity is rechecked after every asynchronous boundary. Discovery
// signatures are never reused to authorize transfers.
export function withdrawalIdentity(account: string) {
  const session = pending, resolution = session && resolveDiscovery(session.session, session.networks);
  if (!session || !resolution?.key || !session.networks.some(n => n.accounts.some(a => a.diagnosis.snapshot.address.toLowerCase() === account.toLowerCase() && keyId(a.publicKey) === keyId(resolution.key!)))) throw Error('Identifique a passkey desta conta novamente.');
  return { key: resolution.key, credentialId: session.session.proof.credentialId, assertCurrent: () => { if (pending !== session) throw Error('A passkey mudou. Prepare novamente.'); } };
}
export async function authorizeWithdrawal(identity: ReturnType<typeof withdrawalIdentity>, hash: import('viem').Hex, snapshot: import('../core/types').AccountSnapshot, client: import('viem').PublicClient, signal: AbortSignal) {
  const { diagnose, verifyOnChain } = await import('../proof/simulation');
  identity.assertCurrent();signal.throwIfAborted();
  const current = await diagnose(client, snapshot.address, snapshot.chainId);
  const signer = current.signers.find(s => s.x.toLowerCase() === identity.key.x.toLowerCase() && s.y.toLowerCase() === identity.key.y.toLowerCase());
  if (!signer || current.snapshot.nonce !== snapshot.nonce) throw Error('A passkey ou o nonce da conta mudou. Prepare novamente.');
  identity.assertCurrent();signal.throwIfAborted();
  const credential = await requestPasskey(hash, identity.credentialId, BUNKER_ORIGIN, signal);
  const signature = await encodeAssertion(assertionFrom(credential), hash, identity.key, BUNKER_ORIGIN);
  identity.assertCurrent();signal.throwIfAborted();
  await verifyOnChain(client, signer.address, hash, signature, current.snapshot.block);
  identity.assertCurrent();signal.throwIfAborted();
  return { owner: signer.address, signature: contractSignature(signer.address, signature) };
}
