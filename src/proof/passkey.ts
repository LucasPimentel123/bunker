import { bytesToHex, concatHex, encodeAbiParameters, hexToBytes, pad, sha256, toHex, type Address, type Hex } from "viem";
import { isPasskeySigner } from "../core/passkey";
import signers from "../catalog/passkey-signers.json";

export const RP_ID = "usepicnic.com";
export const PROOF_ORIGIN = "https://recovery.usepicnic.com:8443";
const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function credentialBytes(id: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{1,1366}$/.test(id)) throw new Error("Identificador de credencial inválido (base64url sem padding).");
  const bytes = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  if (bytes.length > 1024 || base64url(bytes) !== id) throw new Error("Identificador de credencial inválido.");
  return bytes;
}
export type CredentialMetadata = { version: 1; rpId: typeof RP_ID; credentialId: string };
export function importMetadata(text: string): CredentialMetadata {
  if (text.length > 4096) throw new Error("Metadados muito grandes.");
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "credentialId,rpId,version" || value.version !== 1 || value.rpId !== RP_ID || typeof value.credentialId !== "string") {
    throw new Error("Use somente version: 1, rpId: usepicnic.com e credentialId. Nunca importe uma chave privada.");
  }
  credentialBytes(value.credentialId);
  return value;
}
export function signerConfiguration(code: Hex) {
  if (!isPasskeySigner(code)) throw new Error("Signer WebAuthn não reconhecido.");
  const config = signers.find(s => s.runtime.length === code.length)!;
  const word = (offset: number) => `0x${code.slice(2 + offset * 2, 2 + offset * 2 + 64)}` as Hex;
  return { version: config.version, singleton: config.singleton as Address, x: word(config.immutableSlots[2]), y: word(config.immutableSlots[1]), verifiers: word(config.immutableSlots[0]) };
}
export function decodeDer(signature: Uint8Array): readonly [bigint, bigint] {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) throw new Error("Assinatura DER inválida.");
  let cursor = 2;
  function integer() {
    if (signature[cursor++] !== 2) throw new Error("Inteiro DER inválido.");
    const length = signature[cursor++];
    const bytes = signature.slice(cursor, cursor + length);
    cursor += length;
    if (!length || length > 33 || bytes.length !== length || bytes[0] & 0x80 || length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) throw new Error("Inteiro DER inválido.");
    const value = BigInt(bytesToHex(bytes));
    if (value <= 0n || value >= order) throw new Error("Assinatura fora da curva P-256.");
    return value;
  }
  const r = integer(), s = integer();
  if (cursor !== signature.length) throw new Error("Dados extras na assinatura DER.");
  return [r, s] as const;
}
export type Assertion = { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array };
// Shared validation runs before key recovery, RPC queries or signature encoding.
export function validateAssertion(assertion: Assertion, challenge: Hex, origin = PROOF_ORIGIN) {
  if (assertion.clientDataJSON.length > 8192 || assertion.authenticatorData.length > 8192) throw new Error("Resposta WebAuthn muito grande.");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(assertion.clientDataJSON);
  const prefix = `{"type":"webauthn.get","challenge":"${base64url(hexToBytes(challenge))}",`;
  if (!json.startsWith(prefix) || !json.endsWith("}")) throw new Error("Challenge ou formato WebAuthn inesperado.");
  const data = JSON.parse(json);
  if (data.type !== "webauthn.get" || data.challenge !== base64url(hexToBytes(challenge)) || data.origin !== origin || data.crossOrigin !== undefined && data.crossOrigin !== false || data.topOrigin !== undefined) throw new Error("Origem ou challenge da passkey não corresponde à prova local.");
  const auth = assertion.authenticatorData;
  if (auth.length < 37 || bytesToHex(auth.slice(0, 32)) !== sha256(toHex(RP_ID)) || (auth[32] & 5) !== 5) throw new Error("A passkey precisa confirmar domínio, presença e verificação do usuário.");
  const [r, s] = decodeDer(assertion.signature);
  const signed = concatHex([bytesToHex(auth), sha256(bytesToHex(assertion.clientDataJSON))]);
  return { r, s, signed, fields: json.slice(prefix.length, -1) };
}
export async function encodeAssertion(assertion: Assertion, challenge: Hex, config: Pick<ReturnType<typeof signerConfiguration>, "x" | "y">, origin = PROOF_ORIGIN): Promise<Hex> {
  const { r, s, signed, fields } = validateAssertion(assertion, challenge, origin);
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: base64url(hexToBytes(config.x)), y: base64url(hexToBytes(config.y)), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const raw = hexToBytes(concatHex([toHex(r, { size: 32 }), toHex(s, { size: 32 })]));
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(raw), new Uint8Array(hexToBytes(signed)))) throw new Error("Esta passkey não corresponde à chave pública do signer on-chain.");
  return encodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], [bytesToHex(assertion.authenticatorData), fields, r, s]);
}
export function contractSignature(signer: Address, signature: Hex): Hex {
  return concatHex([pad(signer, { size: 32 }), toHex(65, { size: 32 }), "0x00", toHex((signature.length - 2) / 2, { size: 32 }), signature]);
}
export async function requestPasskey(challenge: Hex, credentialId?: string, expectedOrigin = PROOF_ORIGIN, signal?: AbortSignal): Promise<PublicKeyCredential> {
  if (location.origin !== expectedOrigin || !window.isSecureContext) throw new Error("Abra a interface de passkeys na origem confiável configurada.");
  const credential = await navigator.credentials.get({ ...(signal ? { signal } : {}), publicKey: {
    rpId: RP_ID, challenge: new Uint8Array(hexToBytes(challenge)), userVerification: "required", timeout: 60_000,
    ...(credentialId ? { allowCredentials: [{ type: "public-key" as const, id: credentialBytes(credentialId) }] } : {}),
  } });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new Error("Nenhuma passkey foi selecionada.");
  if (credentialId && base64url(new Uint8Array(credential.rawId)) !== credentialId) throw new Error("O navegador retornou outra credencial.");
  return credential;
}
export function assertionFrom(credential: PublicKeyCredential): Assertion {
  const response = credential.response as AuthenticatorAssertionResponse;
  return { authenticatorData: new Uint8Array(response.authenticatorData), clientDataJSON: new Uint8Array(response.clientDataJSON), signature: new Uint8Array(response.signature) };
}
