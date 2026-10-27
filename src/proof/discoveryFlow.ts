import type { PublicClient } from "viem";
import { discoverPasskeyAccounts, type DiscoveryNetwork } from "./discoverAccounts";
import { recoverPublicKeys, type PasskeyProof, type PublicCoordinates } from "./passkeyDiscovery";

export type DiscoverySession = { proof: PasskeyProof; candidates: PublicCoordinates[]; confirmedKey?: PublicCoordinates };
export const keyId = (key: PublicCoordinates) => `${key.x.toLowerCase()}:${key.y.toLowerCase()}`;
export function startDiscovery(proof: PasskeyProof, origin: string): DiscoverySession {
  const candidates = recoverPublicKeys(proof, origin);
  if (!candidates.length) throw new Error("Não foi possível obter chaves candidatas desta passkey.");
  return { proof, candidates };
}
// Count distinct keys, never the number of Safes, signers, or networks. Only
// accounts returned by full on-chain verification may enter this decision.
export function resolveDiscovery(session: DiscoverySession, networks: DiscoveryNetwork[]) {
  const matches = session.candidates.filter(key => networks.some(network => network.accounts.some(account => keyId(account.publicKey) === keyId(key))));
  if (session.confirmedKey) return { key: session.confirmedKey, needsSecondAssertion: false, matches };
  return { key: matches.length === 1 ? matches[0] : undefined, needsSecondAssertion: matches.length > 1, matches };
}
export async function discoverCandidateAccounts(client: PublicClient, chainId: number, session: DiscoverySession, origin: string,
  lookup: Parameters<typeof discoverPasskeyAccounts>[5], progress: (message: string) => void = () => {}): Promise<DiscoveryNetwork> {
  const result: DiscoveryNetwork = { chainId, accounts: [], issues: [] };
  const candidates = session.confirmedKey ? [session.confirmedKey] : session.candidates;
  for (const [index, key] of candidates.entries()) {
    const update = (message: string) => progress(`Candidata ${index + 1} de ${candidates.length} · ${message}`);
    try {
      const found = await discoverPasskeyAccounts(client, chainId, key, session.proof, origin, lookup, update);
      result.accounts.push(...found.accounts);
      result.issues.push(...found.issues);
    } catch (error) {
      result.issues.push(error instanceof Error ? error.message : "Consulta indisponível.");
    }
  }
  result.issues = [...new Set(result.issues)];
  return result;
}
