import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { once } from 'node:events';
import { generateSetupCertificates, validateSetupCertificates, ROOT_EXTENSIONS } from './setup-certificates.mjs';
import { changeHosts, inspectHosts, hostsLine, digest, updateHostsFile } from './setup-hosts.mjs';
import { probeHttps } from './setup.mjs';
import { HOST, ORIGIN } from './server.mjs';
import { applySetup, resumeHostsSetup } from './setup-lifecycle.mjs';

const id = 'ab'.repeat(32);
const openssl = args => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });

test('installation journals interrupted privileged operations and never declares incomplete setup installed', async () => {
  for (const failure of ['trust', 'verifyTrust', 'hosts', 'verifyHosts']) {
    const state = {}, records = [], effects = [];
    const operation = name => async () => { effects.push(name); if (name === failure) throw new Error(`failed ${name}`); };
    await assert.rejects(applySetup({ state, existingMapping: false,
      persist: async current => records.push(structuredClone(current)),
      trust: async () => { assert.equal(records.at(-1).trustAttempted, true); await operation('trust')(); },
      verifyTrust: operation('verifyTrust'),
      hosts: async () => { assert.equal(records.at(-1).hostsAttempted, true); await operation('hosts')(); },
      verifyHosts: operation('verifyHosts'),
    }), /failed/);
    assert.notEqual(records.at(-1).installed, true);
    if (['trust', 'verifyTrust'].includes(failure)) assert.ok(!effects.includes('hosts'));
    await assert.rejects(applySetup({ state }), /já iniciada/);
  }
});
test('installation preserves preexisting mapping and only finishes after verification', async () => {
  const state = {}, records = [];
  await applySetup({ state, existingMapping: true, persist: async current => records.push(structuredClone(current)),
    trust: async () => {}, verifyTrust: async () => {}, hosts: async () => assert.fail('must not change an existing mapping'),
    verifyHosts: async () => assert.notEqual(records.at(-1).installed, true),
  });
  assert.equal(records.at(-1).installed, true);
  assert.notEqual(records.at(-1).hostsAttempted, true);
});

test('hosts add/remove restores exact bytes and preserves subsequent unrelated changes', () => {
  for (const original of ['127.0.0.1 localhost', '127.0.0.1 localhost\n', '# café\r\n127.0.0.1 localhost\r\n']) {
    const before = Buffer.from(original);
    const added = changeHosts(before, 'add', id, digest(before));
    assert.equal(inspectHosts(added), true);
    assert.deepEqual(changeHosts(added, 'remove', id), before);
    const later = Buffer.from('\n10.0.0.2 later.example\n');
    assert.deepEqual(changeHosts(Buffer.concat([added, later]), 'remove', id), Buffer.concat([before, later]));
  }
});
test('hosts refuses conflicting mappings, stale review, changed markers and injected identifiers', () => {
  const conflict = Buffer.from(`::1 ${HOST}\n`);
  assert.throws(() => changeHosts(conflict, 'add', id, digest(conflict)), /diferente/);
  assert.throws(() => inspectHosts(Buffer.from(`8.8.8.8 alias ${HOST.toUpperCase()}. # note`)), /diferente/);
  assert.throws(() => changeHosts(Buffer.from('edited'), 'add', id, digest(Buffer.from('original'))), /mudou/);
  assert.throws(() => changeHosts(Buffer.from(`\n${hostsLine(id)} edited\n`), 'remove', id), /editada/);
  assert.throws(() => hostsLine('$(echo bad)'), /inválido/);
  const existing = Buffer.from(`127.0.0.1 ${HOST} # owned by another app\n`);
  assert.deepEqual(changeHosts(existing, 'add', id, digest(existing)), existing);
  assert.deepEqual(changeHosts(existing, 'remove', id), existing);
});

test('hosts file replacement preserves content/mode and refuses symlinks or stale snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'picnic-hosts-test-'));
  try {
    const path = join(dir, 'hosts');
    const original = Buffer.from('127.0.0.1 localhost\n');
    await writeFile(path, original, { mode: 0o640 });
    const before = await stat(path);
    updateHostsFile(path, 'add', id, digest(original));
    const after = await stat(path);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
    assert.throws(() => updateHostsFile(path, 'add', id, digest(original)), /mudou/);
    const later = Buffer.from('\n10.0.0.2 independent.example\n');
    await writeFile(path, Buffer.concat([await readFile(path), later]));
    updateHostsFile(path, 'remove', id);
    assert.deepEqual(await readFile(path), Buffer.concat([original, later]));
    await symlink(path, join(dir, 'link'));
    assert.throws(() => updateHostsFile(join(dir, 'link'), 'add', id, digest(original)), /regular/);
    assert.deepEqual((await readdir(dir)).sort(), ['hosts', 'link']);
  } finally { await rm(dir, { recursive: true }); }
});

test('machine-exclusive short-lived certificates, no retained CA key, rejects replaced material', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'picnic-setup-test-'));
  const dir = join(temp, 'setup');
  try {
    const plan = await generateSetupCertificates(dir);
    const { root, leaf } = await validateSetupCertificates(dir, plan);
    assert.equal(root.ca, true); assert.equal(leaf.ca, false);
    assert.equal(leaf.subjectAltName, `DNS:${HOST}`);
    assert.ok(Date.parse(root.validTo) - Date.now() <= 7 * 86400_000);
    assert.equal((await stat(join(dir, 'key.pem'))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const files = await readdir(dir);
    for (const file of files.filter(file => file !== 'key.pem')) assert.doesNotMatch(await readFile(join(dir, file), 'utf8'), /PRIVATE KEY/);
    await assert.rejects(generateSetupCertificates(dir), { code: 'EEXIST' });
    await assert.rejects(validateSetupCertificates(dir, { ...plan, rootFingerprint: 'bad' }), /Fingerprint/);
    const other = await generateSetupCertificates(join(temp, 'other'));
    assert.notEqual(plan.rootFingerprint, other.rootFingerprint);
  } finally { await rm(temp, { recursive: true }); }
});

test('CA constraints reject parent, sibling, subdomain, mixed SAN, IP and subordinate CA', async () => {
  // Test-only issuer keeps its key to issue adversarial fixtures. The production
  // generator above never writes or retains this key.
  const dir = await mkdtemp(join(tmpdir(), 'picnic-constraints-test-'));
  try {
    const root = join(dir, 'root.pem'), rootKey = join(dir, 'root-key.pem');
    const rootConfig = join(dir, 'root.cnf');
    await writeFile(rootConfig, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=TEST ONLY\n[ext]\n${ROOT_EXTENSIONS}`);
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', rootConfig, '-keyout', rootKey, '-out', root]);
    const key = join(dir, 'key.pem'), csr = join(dir, 'leaf.csr');
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${HOST}`, '-keyout', key, '-out', csr]);
    const sign = async (name, extensions, issuer = root, issuerKey = rootKey, request = csr) => {
      const config = join(dir, `${name}.cnf`), cert = join(dir, `${name}.pem`);
      await writeFile(config, extensions);
      openssl(['x509', '-req', '-in', request, '-CA', issuer, '-CAkey', issuerKey, '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '1', '-extfile', config, '-out', cert]);
      return cert;
    };
    for (const [name, san, valid] of [
      ['valid', `DNS:${HOST}`, true], ['parent', 'DNS:usepicnic.com', false],
      ['sibling', 'DNS:other.usepicnic.com', false], ['subdomain', `DNS:child.${HOST}`, false],
      ['unrelated', 'DNS:example.com', false], ['mixed', `DNS:${HOST},DNS:example.com`, false],
      ['ipv4', 'IP:127.0.0.1', false], ['ipv6', 'IP:::1', false],
    ]) {
      const cert = await sign(name, `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
      const verify = () => openssl(['verify', '-CAfile', root, '-purpose', 'sslserver', cert]);
      if (valid) assert.doesNotThrow(verify, name);
      else assert.throws(verify, /subtree violation/, name);
      if (process.platform === 'darwin') {
        const hostname = san.split(',')[0].replace(/^(DNS|IP):/, '');
        const nativeVerify = () => execFileSync('/usr/bin/security', ['verify-cert', '-r', root, '-c', cert, '-p', 'ssl', '-n', hostname, '-L', '-q'], { stdio: 'pipe', timeout: 10_000 });
        if (valid) assert.doesNotThrow(nativeVerify, `macOS: ${name}`);
        else assert.throws(nativeVerify, undefined, `macOS must enforce constraints: ${name}`);
      }
    }
    const intermediateKey = join(dir, 'intermediate-key.pem'), intermediateCsr = join(dir, 'intermediate.csr');
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=TEST SUBCA', '-keyout', intermediateKey, '-out', intermediateCsr]);
    const intermediate = await sign('intermediate', 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n', root, rootKey, intermediateCsr);
    const child = await sign('child', `basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:${HOST}\nextendedKeyUsage=serverAuth\n`, intermediate, intermediateKey);
    assert.throws(() => openssl(['verify', '-CAfile', root, '-untrusted', intermediate, child]), /path length constraint/);
  } finally { await rm(dir, { recursive: true }); }
});

test('HTTPS probe checks valid TLS, exact served certificate and read-only application identity', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'picnic-https-test-'));
  const dir = join(temp, 'setup');
  let server;
  try {
    const plan = await generateSetupCertificates(dir);
    const root = await readFile(join(dir, 'root.pem'));
    let readOnly = true;
    server = https.createServer({ cert: await readFile(join(dir, 'cert.pem')), key: await readFile(join(dir, 'key.pem')) }, (_req, res) => res.end(JSON.stringify({ origin: ORIGIN, rpId: 'usepicnic.com', readOnly })));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const options = { root, fingerprint: plan.leafFingerprint, port: server.address().port };
    assert.deepEqual(await probeHttps(options), { pinnedTls: true, readOnly: true });
    await assert.rejects(probeHttps({ ...options, fingerprint: 'wrong' }), /Outro certificado/);
    readOnly = false;
    await assert.rejects(probeHttps(options), /Servidor inesperado/);
    await generateSetupCertificates(join(temp, 'unrelated'));
    await assert.rejects(probeHttps({ ...options, root: await readFile(join(temp, 'unrelated/root.pem')) }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true });
  }
});


test('hosts-only resume rechecks trust and does not mark interrupted mutations complete', async () => {
  for (const failure of ['verifyTrust', 'hosts', 'verifyHosts', 'none']) {
    const state = { trustAttempted: true, hostsAttempted: true, installed: false };
    let saved = false;
    const effects = [];
    const step = name => async () => { effects.push(name); if (failure === name) throw new Error(name); };
    const operation = resumeHostsSetup({ state, persist: async () => { saved = true; }, verifyTrust: step('verifyTrust'), hosts: step('hosts'), verifyHosts: step('verifyHosts') });
    if (failure === 'none') { await operation; assert.equal(state.installed, true); assert.equal(saved, true); }
    else { await assert.rejects(operation); assert.equal(state.installed, false); assert.equal(saved, false); }
    if (failure === 'verifyTrust') assert.deepEqual(effects, ['verifyTrust']);
  }
  for (const state of [{}, { trustAttempted: true }, { trustAttempted: true, hostsAttempted: true, installed: true }]) await assert.rejects(resumeHostsSetup({ state }), /Estado/);
});
