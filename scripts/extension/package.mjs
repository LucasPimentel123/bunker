import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const identity = JSON.parse(readFileSync(join(repo, 'extension/identity.json'), 'utf8'));
const networks = JSON.parse(readFileSync(join(repo, 'extension/networks.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const walk = (root, prefix = '') => readdirSync(join(root, prefix)).sort().flatMap(name => {
  const path = join(prefix, name), stat = lstatSync(join(root, path));
  if (stat.isSymbolicLink()) throw new Error('Symlinks are not allowed in the extension archive');
  return stat.isDirectory() ? walk(root, path) : [path];
});

export function auditExtension(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const allowedKeys = ['manifest_version', 'name', 'description', 'version', 'minimum_chrome_version', 'key', 'action', 'icons', 'background', 'host_permissions', 'content_security_policy'];
  if (Object.keys(manifest).some(key => !allowedKeys.includes(key))) throw new Error('Unexpected manifest capability');
  if (manifest.manifest_version !== 3 || manifest.key !== identity.publicKey || manifest.background?.service_worker !== 'background.js' || manifest.action?.default_popup) throw new Error('Unexpected extension identity or entrypoint');
  const indexOrigin = 'https://api.safe.global';
  const rpcOrigins = networks.map(network => new URL(network.rpc).origin);
  const expectedHosts = ['https://usepicnic.com/*', ...rpcOrigins.map(origin => `${origin}/*`), `${indexOrigin}/*`];
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)) throw new Error('Unexpected host permissions');
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${rpcOrigins.join(' ')} ${indexOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`;
  if (JSON.stringify(manifest.content_security_policy) !== JSON.stringify({ extension_pages: csp })) throw new Error('Unexpected content security policy');
  const paths = walk(root);
  const allowedRoot = ['index.html', 'background.js', 'manifest.json', 'INSTALL.md', 'BUILD.json', 'icon16.png', 'icon32.png'];
  for (const path of paths) {
    if (!allowedRoot.includes(path) && !/^assets\/[\w.-]+\.(js|css)$/.test(path)) throw new Error(`Unexpected packaged file: ${path}`);
    if (/\.(js|json|html|md|css)$/.test(path) && /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(readFileSync(join(root, path), 'utf8'))) throw new Error('Private key material in package');
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const scriptTags = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(match => match[0]);
  if (!scriptTags.length || scriptTags.some(tag => !/^<script[^>]*src="\.\/assets\/[\w.-]+\.js"[^>]*><\/script>$/.test(tag))) throw new Error('Only packaged external scripts are allowed');
  for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (!/^\.\/assets\/[\w.-]+\.(js|css)$/.test(path) || !paths.includes(path.slice(2))) throw new Error('External or missing page resource');
  }
  return paths;
}

export function packageExtension() {
  const root = join(repo, 'extension-dist');
  const files = auditExtension(root).filter(path => path !== 'BUILD.json');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
  const build = { commit, dirty, extensionId: identity.id, experimental: true, signedRelease: false,
    files: Object.fromEntries(files.map(path => [path, hash(readFileSync(join(root, path)))])) };
  writeFileSync(join(root, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
  const archive = join(repo, 'artifacts', `picnic-bunker-passkeys-${commit.slice(0, 12)}${dirty ? '-dev' : ''}.zip`);
  mkdirSync(join(repo, 'artifacts'), { recursive: true });
  rmSync(archive, { force: true }); // Never retain stale entries from an older archive.
  execFileSync('zip', ['-q', '-X', archive, ...auditExtension(root)], { cwd: root });
  const sha256 = hash(readFileSync(archive));
  writeFileSync(`${archive}.sha256`, `${sha256}  ${archive.split('/').at(-1)}\n`);
  console.log(JSON.stringify({ archive, sha256, extensionId: identity.id, signedRelease: false }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageExtension();
