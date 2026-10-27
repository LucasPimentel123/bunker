import identity from "../../extension/identity.json";

export const EXTENSION_ORIGIN = `chrome-extension://${identity.id}`;
// Pin the expected development package ID. It is context binding, NOT proof of
// publisher authenticity: an unpacked clone can copy a public manifest key.
export function assertExtensionContext(origin: string, runtimeId: string | undefined) {
  if (origin !== EXTENSION_ORIGIN || runtimeId !== identity.id) throw new Error("Abra o Picnic Bunker pelo ícone da extensão instalada.");
}
export function verifyExtensionContext() {
  const extension = (globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string } } }).chrome;
  assertExtensionContext(location.origin, extension?.runtime?.id);
}
