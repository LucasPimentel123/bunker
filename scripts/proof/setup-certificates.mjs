import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { HOST } from './server.mjs';

// Restrictions travel with the trust anchor, rather than macOS PolicyString,
// which Chromium ignores. Excluding the leading-dot subtree leaves only HOST.
export const ROOT_EXTENSIONS = `basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
extendedKeyUsage=serverAuth
nameConstraints=critical,permitted;DNS:${HOST},excluded;DNS:.${HOST},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:0:0:0:0:0:0:0:0/0:0:0:0:0:0:0:0
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid:always
`;
export const LEAF_EXTENSIONS = `basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:${HOST}
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
`;
const openssl = (args, input) => execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 });

export async function generateSetupCertificates(dir) {
  // Exclusive directory creation: never overwrite an installed setup, even if
  // preparation was interrupted. Keep failed material available for inspection.
  await mkdir(dir, { mode: 0o700 });
  const rootConfig = join(dir, 'root.cnf');
  const leafConfig = join(dir, 'leaf.cnf');
  await writeFile(rootConfig, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=Picnic recovery local ${randomBytes(8).toString('hex')}\n[ext]\n${ROOT_EXTENSIONS}`, { mode: 0o600, flag: 'wx' });
  await writeFile(leafConfig, LEAF_EXTENSIONS, { mode: 0o600, flag: 'wx' });
  // No CA private key file, shared CA, downloads or retained issuance key.
  // The in-memory buffer is discarded after issuing this single server cert.
  const rootKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const root = join(dir, 'root.pem'), cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  try {
    openssl(['req', '-x509', '-new', '-key', '/dev/stdin', '-sha256', '-days', '7', '-config', rootConfig, '-out', root], rootKey);
    const leafKey = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    try { await writeFile(key, leafKey, { mode: 0o600, flag: 'wx' }); } finally { leafKey.fill(0); }
    openssl(['req', '-new', '-key', key, '-subj', `/CN=${HOST}`, '-out', join(dir, 'leaf.csr')]);
    openssl(['x509', '-req', '-in', join(dir, 'leaf.csr'), '-CA', root, '-CAkey', '/dev/stdin', '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '7', '-sha256', '-extfile', leafConfig, '-out', cert], rootKey);
    openssl(['verify', '-CAfile', root, '-purpose', 'sslserver', '-verify_hostname', HOST, cert]);
  } finally { rootKey.fill(0); }
  const rootX509 = new X509Certificate(await readFile(root));
  const leafX509 = new X509Certificate(await readFile(cert));
  return { rootFingerprint: rootX509.fingerprint256, leafFingerprint: leafX509.fingerprint256, validTo: rootX509.validTo };
}

export async function validateSetupCertificates(dir, plan) {
  const root = new X509Certificate(await readFile(join(dir, 'root.pem')));
  const leaf = new X509Certificate(await readFile(join(dir, 'cert.pem')));
  if (root.fingerprint256 !== plan.rootFingerprint || leaf.fingerprint256 !== plan.leafFingerprint) throw new Error('Fingerprint mudou desde a preparação. Nada será instalado.');
  if (!root.ca || leaf.ca || leaf.subjectAltName !== `DNS:${HOST}` || !leaf.verify(root.publicKey)) throw new Error('Certificados fora do escopo esperado.');
  if (Date.parse(root.validTo) <= Date.now() || Date.parse(leaf.validTo) <= Date.now()) throw new Error('Certificados expirados; remova esta instalação antes de preparar outra.');
  for (const path of [dir, join(dir, 'key.pem')]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Material TLS precisa pertencer ao usuário e estar inacessível a outros usuários.');
  }
  openssl(['verify', '-CAfile', join(dir, 'root.pem'), '-purpose', 'sslserver', '-verify_hostname', HOST, join(dir, 'cert.pem')]);
  return { root, leaf };
}
