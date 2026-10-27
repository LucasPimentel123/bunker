import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { hexToBytes, type Hex } from "viem";
import { RP_ID, PROOF_ORIGIN, base64url, type Assertion } from "../../src/proof/passkey";
export function testKey() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  const config = { version: "test", x: `0x${Buffer.from(jwk.x!, "base64url").toString("hex")}` as Hex, y: `0x${Buffer.from(jwk.y!, "base64url").toString("hex")}` as Hex, verifiers: "0x00" as Hex };
  return { ...keys, config };
}
export function testAssertion(keys: ReturnType<typeof testKey>, challenge: Hex, options: { origin?: string; flags?: number; rpId?: string; crossOrigin?: boolean } = {}): Assertion {
  const authenticatorData = Buffer.concat([createHash("sha256").update(options.rpId ?? RP_ID).digest(), Buffer.from([options.flags ?? 5]), Buffer.alloc(4)]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: base64url(hexToBytes(challenge)), origin: options.origin ?? PROOF_ORIGIN, crossOrigin: options.crossOrigin ?? false }));
  const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  return { authenticatorData, clientDataJSON, signature: sign("sha256", message, keys.privateKey) };
}
