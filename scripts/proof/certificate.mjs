import { mkdir, chmod, access, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
const dir = resolve('.local-proof');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const key = resolve(dir, 'key.pem'), cert = resolve(dir, 'cert.pem');
for (const file of [key, cert, resolve(dir, 'plan.json')]) {
  try { await access(file); throw new Error(`Já existe material TLS em ${dir}. Não será substituído. Consulte docs/passkey-proof.md.`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const config = resolve(dir, 'openssl.cnf');
await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=recovery.usepicnic.com\nO=Picnic local recovery proof\n[ext]\nsubjectAltName=DNS:recovery.usepicnic.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '7', '-keyout', key, '-out', cert, '-config', config], { stdio: 'ignore' });
await chmod(key, 0o600);
const x509 = new X509Certificate(await readFile(cert));
const plan = { hostname: 'recovery.usepicnic.com', address: '127.0.0.1', port: 8443, cert, fingerprint256: x509.fingerprint256, fingerprint: x509.fingerprint, validTo: x509.validTo, installedTrust: false, changedHosts: false };
await writeFile(resolve(dir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(plan, null, 2));
console.log('Certificado exclusivo criado. Nenhuma confiança foi instalada e /etc/hosts não foi alterado. Revise docs/passkey-proof.md antes de autorizar esses passos.');
