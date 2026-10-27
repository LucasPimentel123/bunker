import { readFile, writeFile, mkdir, lstat, rm, rename, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { generateSetupCertificates, validateSetupCertificates } from './setup-certificates.mjs';
import { digest, hostsLine, inspectHosts } from './setup-hosts.mjs';
import { applySetup, resumeHostsSetup } from './setup-lifecycle.mjs';
import { HOST, PORT, ORIGIN, serveProof, validateRpc } from './server.mjs';

import { PROFILE, BUILD_DIRECTORY, SETUP_DIRECTORY, SETUP_SCRIPT } from './profile.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = join(repo, '.local-proof', SETUP_DIRECTORY);
const keychain = join(homedir(), 'Library/Keychains/login.keychain-db');
const paths = { root: join(dir, 'root.pem'), cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem'), plan: join(dir, 'setup.json'), state: join(dir, 'state.json') };
const run = (bin, args, options = {}) => execFileSync(bin, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
const save = async (path, value) => {
  const temporary = `${path}.next`;
  const fd = await open(temporary, 'w', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); await fd.sync(); }
  finally { await fd.close(); }
  await rename(temporary, path);
};
const fingerprintId = fingerprint => fingerprint.replaceAll(':', '').toLowerCase();
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function readPlan() {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Diretório da instalação inválido.');
  const plan = JSON.parse(await readFile(paths.plan, 'utf8'));
  if (plan.version !== 2 || plan.hostname !== HOST || plan.keychain !== keychain || plan.id !== fingerprintId(plan.rootFingerprint) || !/^[a-f0-9]{64}$/.test(plan.id)) throw new Error('Plano inválido ou pertence a outro usuário.');
  return plan;
}
async function readState() {
  try { return JSON.parse(await readFile(paths.state, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function macOnly() { if (process.platform !== 'darwin' || process.getuid() === 0) throw new Error('Execute como usuário normal no macOS. Suporte a outros sistemas ainda não foi validado.'); }
function trustCommand() { return ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, paths.root]; }
function hostsOperation(operation, plan) {
  run('/usr/bin/sudo', ['/usr/bin/env', `PICNIC_PROOF_PROFILE=${PROFILE}`, process.execPath, join(repo, 'scripts/proof/setup-hosts.mjs'), operation, plan.id, plan.hostsDigest], { stdio: 'inherit', timeout: 0 });
}
function keychainContains(fingerprint) {
  const pem = run('/usr/bin/security', ['find-certificate', '-a', '-p', keychain]);
  return (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).some(cert => new X509Certificate(cert).fingerprint256 === fingerprint);
}

export function reviewText(plan) {
  return `# Proposta de HTTPS local — ainda não aplicada

Origem: ${ORIGIN}. Somente 127.0.0.1. Usuário atual; nenhum DNS público é alterado.

## Mudança de mecanismo

Instalar uma autoridade TLS local exclusiva, válida por sete dias, com nameConstraints críticos que permitem somente ${HOST}, excluem seus subdomínios e todos os IPs, e pathlen:0. A chave de emissão não é gravada em disco e é descartada após emitir um único certificado de servidor. A chave de servidor fica em ${paths.key}, modo 600.

Esta é uma CA restrita, não a entrada anterior de confiança em um certificado de servidor. A restrição sai do PolicyString do Keychain (ignorado pelo Chrome) e fica no certificado. O comando não usa -s. Isso requer aprovação específica; a autorização anterior não é reutilizada automaticamente.

Compatibilidade e restrições testadas em OpenSSL/Node não equivalem a validação no Chrome ou nos demais aplicativos do macOS. O teste real no navegador e com a passkey ainda é obrigatório. Nenhuma configuração de HSTS, navegador ou verificação TLS é desativada.

CA SHA-256: ${plan.rootFingerprint}
Servidor SHA-256: ${plan.leafFingerprint}
Expiração: ${plan.validTo}
CA: ${paths.root}
Keychain: ${keychain}
Código preparado a partir de: ${plan.commit}${plan.dirty ? ' (há alterações locais; não é uma release autenticada)' : ''}

## Alterações exatas

Confiança SSL no Keychain do usuário:
\`\`\`sh
/usr/bin/security ${trustCommand().map(quote).join(' ')}
\`\`\`

${plan.existingMapping ? 'Já há uma entrada 127.0.0.1 para o domínio. Ela será reutilizada e não será removida por esta instalação.' : `Acrescentar somente esta linha a /etc/hosts, preservando o conteúdo existente:\n\n${hostsLine(plan.id)}`}

SHA-256 de /etc/hosts revisado: ${plan.hostsDigest}
Backup: ${join(dir, 'hosts.before')}
Nenhum certificado/configuração do protótipo anterior será removido automaticamente.

## Aplicação após autorização

\`\`\`sh
npm run ${SETUP_SCRIPT} -- install ${plan.id}
npm run ${SETUP_SCRIPT} -- serve https://polygon-bor-rpc.publicnode.com
\`\`\`

O comando install não abre o navegador nem solicita passkey. O servidor usa os arquivos preparados aqui. Se a porta estiver ocupada, encerre a instância anterior antes de iniciar outra.

## Reversão

Encerre o servidor (Ctrl+C). Execute npm run ${SETUP_SCRIPT} -- remove ${plan.id}. Isso remove a confiança e o certificado da CA por fingerprint e somente a linha hosts marcada por esta instalação, preservando alterações posteriores. Uma entrada de domínio preexistente permanece intacta. Material TLS é mantido se a remoção falhar. Não remove passkeys nem configurações antigas.

Se o instalador estiver indisponível, a remoção da confiança é:
\`\`\`sh
/usr/bin/security remove-trusted-cert ${quote(paths.root)}
/usr/bin/security delete-certificate -Z ${plan.id.toUpperCase()} ${quote(keychain)}
\`\`\`
Depois remova apenas a linha marcada acima (se foi criada), mantendo todos os outros bytes de /etc/hosts.
`;
}

async function prepare() {
  macOnly();
  run('openssl', ['version']);
  const node = process.versions.node.split('.').map(Number);
  if (node[0] < 22 || (node[0] === 22 && node[1] < 12)) throw new Error('É necessário Node 22.12 ou posterior.');
  await readFile(join(repo, BUILD_DIRECTORY, 'index.html')); // Build before asking for setup approval.
  const hosts = await readFile('/etc/hosts');
  const existingMapping = inspectHosts(hosts);
  await mkdir(join(repo, '.local-proof'), { recursive: true, mode: 0o700 });
  const parent = await lstat(join(repo, '.local-proof'));
  if (parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw new Error('.local-proof precisa ser um diretório privado do usuário.');
  const certs = await generateSetupCertificates(dir);
  const plan = { version: 2, hostname: HOST, keychain, ...certs, id: fingerprintId(certs.rootFingerprint), hostsDigest: digest(hosts), existingMapping, commit: run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim(), dirty: !!run('git', ['status', '--porcelain'], { cwd: repo }).trim() };
  await writeFile(join(dir, 'hosts.before'), hosts, { mode: 0o600, flag: 'wx' });
  await save(paths.plan, plan);
  await save(paths.state, { trustAttempted: false, hostsAttempted: false, installed: false });
  await writeFile(join(dir, 'review.md'), reviewText(plan), { mode: 0o600, flag: 'wx' });
  console.log(`Preparado. Nenhuma confiança ou configuração de domínio alterada.\nRevise: ${join(dir, 'review.md')}\nCA SHA-256: ${plan.rootFingerprint}`);
}

async function install(approvedId) {
  macOnly();
  const plan = await readPlan();
  if (approvedId !== plan.id) throw new Error('Revise review.md e forneça o fingerprint aprovado. A skill deve obter autorização antes deste comando.');
  await validateSetupCertificates(dir, plan);
  const hosts = await readFile('/etc/hosts');
  if (digest(hosts) !== plan.hostsDigest) throw new Error('/etc/hosts mudou desde a revisão; nada foi instalado.');
  const state = await readState();
  if (state.trustAttempted || state.hostsAttempted) throw new Error('Instalação já iniciada. Execute doctor ou remove; não repita alterações às cegas.');
  if (keychainContains(plan.rootFingerprint)) throw new Error('Este certificado já está no Keychain; não assumiremos propriedade dele.');
  try {
    await applySetup({ state, existingMapping: plan.existingMapping,
      persist: current => save(paths.state, current),
      trust: () => run('/usr/bin/security', trustCommand(), { stdio: 'inherit', timeout: 0 }),
      verifyTrust: () => run('/usr/bin/security', ['verify-cert', '-c', paths.cert, '-p', 'ssl', '-n', HOST, '-L']),
      hosts: () => hostsOperation('add', plan),
      verifyHosts: async () => { if (!inspectHosts(await readFile('/etc/hosts'))) throw new Error('Resolução local ausente após a instalação.'); },
    });
    console.log(`Instalação aplicada. Execute doctor e serve. Chrome e passkey ainda precisam de validação real.\n${ORIGIN}`);
  } catch (error) {
    console.error(`Instalação incompleta; o registro foi preservado. Para reverter: npm run ${SETUP_SCRIPT} -- remove ${plan.id}`);
    throw error;
  }
}

async function resumeHosts(approvedId) {
  macOnly();
  const plan = await readPlan();
  if (approvedId !== plan.id) throw new Error('Forneça o fingerprint aprovado.');
  await validateSetupCertificates(dir, plan);
  const state = await readState();
  if (plan.existingMapping) throw new Error('Este plano não deveria alterar hosts; revise o estado.');
  const verifyOwnedMapping = async () => {
    const content = await readFile('/etc/hosts');
    if (!inspectHosts(content) || !content.includes(Buffer.from(`\n${hostsLine(plan.id)}\n`))) throw new Error('Mapeamento exato desta instalação não encontrado.');
  };
  await resumeHostsSetup({ state, persist: current => save(paths.state, current),
    verifyTrust: async () => {
      if (!keychainContains(plan.rootFingerprint)) throw new Error('Certificado aprovado ausente; não é seguro retomar hosts.');
      run('/usr/bin/security', ['verify-cert', '-c', paths.cert, '-p', 'ssl', '-n', HOST, '-L']);
    },
    hosts: async () => {
      const content = await readFile('/etc/hosts');
      if (inspectHosts(content)) { await verifyOwnedMapping(); return; }
      if (digest(content) !== plan.hostsDigest) throw new Error('/etc/hosts mudou desde a revisão; retomada interrompida.');
      hostsOperation('add', plan);
    },
    verifyHosts: verifyOwnedMapping,
  });
  console.log(`Configuração local concluída. ${ORIGIN}`);
}

export async function probeHttps({ root, fingerprint, port = PORT }) {
  return new Promise((resolveProbe, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port, path: '/config', headers: { host: `${HOST}:${PORT}` }, ca: root, servername: HOST, agent: false }, res => {
      if (res.socket.getPeerCertificate().fingerprint256 !== fingerprint) { res.destroy(); reject(new Error('Outro certificado está sendo servido nesta porta.')); return; }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 4096) res.destroy(new Error('Resposta inesperada.')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const config = JSON.parse(data);
          if (res.statusCode !== 200 || config.origin !== ORIGIN || config.readOnly !== true || config.rpId !== 'usepicnic.com') throw new Error('Servidor inesperado.');
          resolveProbe({ pinnedTls: true, readOnly: true });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS local excedeu 5 segundos.')));
    req.on('error', reject);
  });
}

async function doctor() {
  macOnly();
  const plan = await readPlan();
  const result = { browser: 'not-verified', passkey: 'not-verified' };
  const check = async (name, fn) => { try { result[name] = await fn(); } catch (error) { result[name] = { ok: false, reason: error.message }; } };
  await check('certificates', async () => { await validateSetupCertificates(dir, plan); return { ok: true, expires: plan.validTo }; });
  await check('hosts', async () => ({ ok: inspectHosts(await readFile('/etc/hosts')) }));
  await check('resolution', async () => { const ips = await lookup(HOST, { all: true }); return { ok: ips.length > 0 && ips.every(ip => ip.address === '127.0.0.1'), addresses: ips.map(ip => ip.address) }; });
  await check('macOSTrust', async () => { run('/usr/bin/security', ['verify-cert', '-c', paths.cert, '-p', 'ssl', '-n', HOST, '-L']); return { ok: true }; });
  await check('localServer', async () => ({ ok: true, ...await probeHttps({ root: await readFile(paths.root), fingerprint: plan.leafFingerprint }) }));
  if (['certificates', 'hosts', 'resolution', 'macOSTrust', 'localServer'].every(name => result[name]?.ok)) {
    result.browserNextStep = 'Abra a URL no navegador que contém sua carteira. Se o Chrome mostrar NET::ERR_CERT_AUTHORITY_INVALID, salve o trabalho e reinicie-o completamente (chrome://restart), então reabra a URL. Não ignore avisos TLS. Se persistir, revise certificado, perfil e políticas do navegador. HTTPS aceito não confirma a passkey.';
  }
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result).some(value => typeof value === 'object' && !value.ok)) process.exitCode = 1;
}

async function remove(approvedId) {
  macOnly();
  const plan = await readPlan();
  if (approvedId !== plan.id) throw new Error('Forneça o identificador exato da instalação a remover.');
  const listening = await new Promise(resolveProbe => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => { socket.destroy(); resolveProbe(true); });
    socket.once('error', error => resolveProbe(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(1500, () => { socket.destroy(); resolveProbe(true); });
  });
  if (listening) throw new Error('Encerre o servidor local da porta 8443 antes da remoção. Não encerraremos um processo desconhecido.');
  // Expired certificates still need cleanup; fingerprint check remains mandatory.
  if (new X509Certificate(await readFile(paths.root)).fingerprint256 !== plan.rootFingerprint) throw new Error('Certificado mudou; limpeza interrompida.');
  const state = await readState();
  if (state.trustAttempted && keychainContains(plan.rootFingerprint)) {
    run('/usr/bin/security', ['remove-trusted-cert', paths.root], { stdio: 'inherit', timeout: 0 });
    run('/usr/bin/security', ['delete-certificate', '-Z', plan.id.toUpperCase(), keychain]);
    if (keychainContains(plan.rootFingerprint)) throw new Error('Certificado ainda está no Keychain. Material local preservado.');
  }
  if (state.hostsAttempted) hostsOperation('remove', plan);
  if ((await readFile('/etc/hosts')).includes(Buffer.from(`picnic-recovery-setup-${plan.id}`))) throw new Error('Entrada hosts ainda presente; material local preservado.');
  await rm(dir, { recursive: true });
  console.log('Configurações desta instalação removidas. Configurações preexistentes e passkeys foram preservadas.');
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'prepare') return prepare();
  if (command === 'install' || command === 'remove' || command === 'resume-hosts') {
    macOnly(); await readPlan();
    const lockPath = join(dir, '.operation.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Há uma operação em andamento ou interrompida. Revise o registro antes de remover .operation.lock.'); throw error; }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, command }));
      return command === 'install' ? await install(arg) : command === 'resume-hosts' ? await resumeHosts(arg) : await remove(arg);
    } finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
  if (command === 'doctor') return doctor();
  if (command === 'serve') {
    macOnly();
    const plan = await readPlan(); await validateSetupCertificates(dir, plan);
    validateRpc(arg);
    if (!(await readState()).installed) throw new Error('Instale a configuração revisada antes de iniciar.');
    return serveProof(arg, { root: join(repo, BUILD_DIRECTORY), tlsDir: dir });
  }
  throw new Error(`Uso: npm run ${SETUP_SCRIPT} -- prepare | install FINGERPRINT | doctor | serve RPC_HTTPS | remove FINGERPRINT`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
