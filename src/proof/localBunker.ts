export const BUNKER_ORIGIN = "https://bunker.usepicnic.com:8443";
export function assertLocalBunker(origin: string, secure: boolean) {
  if (origin !== BUNKER_ORIGIN || !secure) throw new Error(`Abra o Bunker local em ${BUNKER_ORIGIN}.`);
}
