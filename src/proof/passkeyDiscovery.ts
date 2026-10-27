import { p256 } from "@noble/curves/p256";
import { bytesToHex, concatHex, encodeAbiParameters, getCreate2Address, hexToBytes, sha256, toHex, type Hex } from "viem";
import factories from "../catalog/passkey-factories.json";
import { credentialBytes, encodeAssertion, validateAssertion, type Assertion } from "./passkey";

export type PasskeyProof = { credentialId: string; challenge: Hex; assertion: Assertion };
export type PublicCoordinates = { x: Hex; y: Hex };
export function discoveryChallenge(): Hex {
  return sha256(concatHex([toHex("Picnic Bunker: discover accounts only; no transaction"), bytesToHex(crypto.getRandomValues(new Uint8Array(32)))]));
}
// One assertion yields candidate keys, not a uniquely identified credential key.
// Discovery checks each candidate against deployed signer/Safe code and ownership.
// Only multiple candidates with verified Safes require a second local challenge.
export function recoverPublicKeys(proof: PasskeyProof, origin: string): PublicCoordinates[] {
  credentialBytes(proof.credentialId);
  const { r, s, signed } = validateAssertion(proof.assertion, proof.challenge, origin);
  const signature = p256.Signature.fromCompact(hexToBytes(concatHex([toHex(r, { size: 32 }), toHex(s, { size: 32 })])));
  const digest = hexToBytes(sha256(signed));
  const candidates: PublicCoordinates[] = [];
  for (let recovery = 0; recovery < 4; recovery++) {
    try {
      const key = signature.addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
      candidates.push({ x: bytesToHex(key.slice(1, 33)), y: bytesToHex(key.slice(33)) });
    } catch { /* Not every recovery bit corresponds to a point on the curve. */ }
  }
  return candidates;
}
export async function identifyPasskey(first: PasskeyProof, second: PasskeyProof, origin: string): Promise<PublicCoordinates> {
  if (first.credentialId !== second.credentialId) throw new Error("Selecione a mesma passkey nas duas verificações.");
  if (first.challenge.toLowerCase() === second.challenge.toLowerCase()) throw new Error("As verificações precisam de desafios diferentes.");
  const a = recoverPublicKeys(first, origin), b = recoverPublicKeys(second, origin);
  const matches = a.filter(key => b.some(other => key.x === other.x && key.y === other.y));
  if (matches.length !== 1) throw new Error("Não foi possível identificar uma única chave pública. Repita a identificação.");
  await encodeAssertion(first.assertion, first.challenge, matches[0], origin);
  await encodeAssertion(second.assertion, second.challenge, matches[0], origin);
  return matches[0];
}
export function predictPasskeySigners(key: PublicCoordinates) {
  return factories.flatMap(config => config.verifiers.map(verifiers => ({
    ...key, version: config.version, singleton: config.singleton, verifiers: BigInt(verifiers),
    address: getCreate2Address({ from: config.factory as Hex, salt: toHex(0n, { size: 32 }),
      bytecode: concatHex([config.creationCode as Hex, encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [BigInt(config.singleton), BigInt(key.x), BigInt(key.y), BigInt(verifiers)],
      )]),
    }),
  })));
}
