// Fixed local profiles only; never accept a caller-supplied hostname or bind address.
export const PROFILE = process.env.PICNIC_PROOF_PROFILE ?? 'recovery';
if (!['recovery', 'bunker'].includes(PROFILE)) throw new Error('Perfil local inválido.');
export const BUNKER = PROFILE === 'bunker';
export const HOST = BUNKER ? 'bunker.usepicnic.com' : 'recovery.usepicnic.com';
export const PORT = 8443;
export const ORIGIN = `https://${HOST}:${PORT}`;
export const BUILD_DIRECTORY = BUNKER ? 'bunker-dist' : 'proof-dist';
export const SETUP_DIRECTORY = BUNKER ? 'setup-bunker' : 'setup-v2';
export const SETUP_SCRIPT = BUNKER ? 'bunker:setup' : 'proof:setup';
