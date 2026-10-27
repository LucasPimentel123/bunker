import { keccak256, type Address, type PublicClient } from "viem";
import { assertChain, same } from "../core/client";
import { encodeAssertion, signerConfiguration } from "./passkey";
import { predictPasskeySigners, type PasskeyProof, type PublicCoordinates } from "./passkeyDiscovery";
import { diagnose, verifyOnChain, type Diagnosis } from "./simulation";
import signerHashes from "./signer-codehashes.json";
import type { AccountHints } from "../extension/accountIndex";

export type DiscoveredAccount = { diagnosis: Diagnosis; signer: Address; publicKey: PublicCoordinates; needsRevalidation?: boolean };
export type DiscoveryNetwork = { chainId: number; accounts: DiscoveredAccount[]; issues: string[] };
export async function verifyDiscoveredAccount(client: PublicClient, address: Address, chainId: number, signer: Address, key: PublicCoordinates, proof: PasskeyProof, origin: string): Promise<DiscoveredAccount> {
  const diagnosis = await diagnose(client, address, chainId);
  const current = diagnosis.signers.find(candidate => same(candidate.address, signer) && candidate.x === key.x && candidate.y === key.y);
  if (!current) throw new Error("A passkey não é owner atual desta Safe.");
  const signature = await encodeAssertion(proof.assertion, proof.challenge, current, origin);
  await verifyOnChain(client, current.address, proof.challenge, signature, diagnosis.snapshot.block);
  return { diagnosis, signer: current.address, publicKey: key };
}
export async function discoverPasskeyAccounts(client: PublicClient, chainId: number, key: PublicCoordinates, proof: PasskeyProof, origin: string,
  lookup: (chainId: number, owner: Address) => Promise<AccountHints>, progress: (message: string) => void = () => {}): Promise<DiscoveryNetwork> {
  const result: DiscoveryNetwork = { chainId, accounts: [], issues: [] };
  // Revalidate locally before sharing any derived public signer with providers.
  await encodeAssertion(proof.assertion, proof.challenge, key, origin);
  await assertChain(client, chainId);
  const blockNumber = await client.getBlockNumber();
  for (const candidate of predictPasskeySigners(key)) {
    progress("Verificando signer na blockchain…");
    try {
      const code = await client.getCode({ address: candidate.address, blockNumber });
      if (!code || code === "0x") continue;
      const config = signerConfiguration(code);
      if (config.x !== key.x || config.y !== key.y || config.version !== candidate.version || BigInt(config.verifiers) !== candidate.verifiers || !same(config.singleton, candidate.singleton)) throw new Error("Signer diverge da configuração calculada localmente.");
      const singletonCode = await client.getCode({ address: config.singleton, blockNumber });
      if (!singletonCode || keccak256(singletonCode) !== signerHashes[config.version as keyof typeof signerHashes]) throw new Error("Bytecode do signer não reconhecido.");
      progress("Localizando contas no índice público da Safe…");
      const hints = await lookup(chainId, candidate.address);
      result.issues.push(...hints.issues ?? []);
      if (hints.incomplete) result.issues.push("A busca de contas ficou parcial. Repita para continuar a consulta.");
      if (!hints.addresses.length) result.issues.push("Signer encontrado, mas nenhuma conta foi localizada nesta consulta. Isso não comprova ausência de contas.");
      for (const address of hints.addresses) {
        progress("Confirmando propriedade das contas na blockchain…");
        try {
          const verified = await verifyDiscoveredAccount(client, address, chainId, candidate.address, key, proof, origin);
          if (!result.accounts.some(account => same(account.diagnosis.snapshot.address, address))) result.accounts.push(verified);
        } catch { result.issues.push(`Não foi possível confirmar ${address}. Pode ser um registro antigo, uma configuração não suportada ou uma falha de consulta.`); }
      }
    } catch (error) { result.issues.push(error instanceof Error ? error.message : "Falha ao consultar signer ou índice."); }
  }
  return result;
}
