import { readFile, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostname = 'bunker.usepicnic.com';
const guidedUrl = `https://${hostname}:8443/designs/guided.html?design=segments`;
const requiredBuild = [
  'index.html', 'designs/guided.html', 'designs/assets/guided-live.js',
  'designs/assets/runtime/guided-discovery.js', 'designs/assets/runtime/guided-wallet.js',
];
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function jsonFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular local state file.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function inspectSetup(repo, now) {
  const directory = join(repo, '.local-proof/setup-bunker');
  if (!await exists(directory)) return { state: 'absent' };
  const result = { state: 'invalid', directory };
  try {
    const stat = await lstat(directory);
    const parent = await lstat(join(repo, '.local-proof'));
    if (!stat.isDirectory() || stat.isSymbolicLink() || parent.isSymbolicLink()) {
      throw new Error('Setup must be a real local directory.');
    }
    const plan = await jsonFile(join(directory, 'setup.json'));
    const state = await jsonFile(join(directory, 'state.json'));
    if (plan.version !== 2 || plan.hostname !== hostname || !/^[a-f0-9]{64}$/.test(plan.id)
      || typeof plan.rootFingerprint !== 'string'
      || plan.rootFingerprint.replaceAll(':', '').toLowerCase() !== plan.id
      || !Number.isFinite(Date.parse(plan.validTo))) throw new Error('Unexpected setup plan.');
    for (const key of ['trustAttempted', 'hostsAttempted', 'installed']) {
      if (typeof state[key] !== 'boolean') throw new Error('Incomplete installation journal.');
    }
    if (state.installed && !state.trustAttempted) throw new Error('Inconsistent installation journal.');
    const review = join(directory, 'review.md');
    const missing = [];
    for (const name of ['root.pem', 'cert.pem', 'key.pem', 'review.md']) {
      if (!await exists(join(directory, name))) missing.push(name);
    }
    if (missing.length) throw new Error(`Incomplete setup material: ${missing.join(', ')}.`);
    const locked = await exists(join(directory, '.operation.lock'));
    return {
      state: locked ? 'interrupted'
        : Date.parse(plan.validTo) <= now ? 'expired'
        : state.installed ? 'installed'
        : state.trustAttempted || state.hostsAttempted ? 'interrupted' : 'prepared',
      directory, review, fingerprint: plan.id, expires: plan.validTo, operationLock: locked,
      // Journal state is only a hint. Doctor checks actual trust/hosts/TLS.
      systemVerified: false,
    };
  } catch {
    // Never echo malformed state, paths from that state, or credential-like fields.
    return { ...result, reason: 'Missing, malformed or inconsistent setup material; inspect locally before continuing.' };
  }
}

export async function inspectCheckout(path, {
  expectedRevision, platform = process.platform, nodeVersion = process.versions.node,
  now = Date.now(), execute = run,
} = {}) {
  if (!path) throw new Error('Provide the absolute Bunker checkout path.');
  const repo = await realpath(resolve(path));
  const pkg = await jsonFile(join(repo, 'package.json'));
  if (pkg.name !== '@usepicnic/bunker' || !pkg.scripts?.['bunker:build'] || !pkg.scripts?.['bunker:setup']) {
    throw new Error('This directory is not a Bunker application checkout.');
  }
  const top = await realpath(execute('git', ['rev-parse', '--show-toplevel'], repo));
  if (top !== repo) throw new Error('Use the root of the standalone Bunker repository.');
  const revision = execute('git', ['rev-parse', 'HEAD'], repo);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Cannot identify the source revision.');
  if (expectedRevision && expectedRevision !== revision) throw new Error('The source revision changed; review it before continuing.');
  let remoteMatchesExpected = false;
  try {
    remoteMatchesExpected = /^(?:https:\/\/github\.com\/|git@github\.com:)usePicnic\/bunker(?:\.git)?$/i
      .test(execute('git', ['remote', 'get-url', 'origin'], repo));
  } catch { /* A local/offline checkout may have no remote. Never print remote credentials. */ }
  const tools = {};
  for (const [name, args] of [['npm', ['--version']], ['openssl', ['version']]]) {
    try { execute(name, args, repo); tools[name] = true; }
    catch { tools[name] = false; }
  }
  const [major, minor] = nodeVersion.split('.').map(Number);
  const missingBuild = [];
  for (const name of requiredBuild) {
    if (!await exists(join(repo, 'bunker-dist', name))) missingBuild.push(name);
  }
  return {
    version: 1,
    source: {
      directory: repo, revision,
      modified: Boolean(execute('git', ['status', '--porcelain'], repo)),
      remoteMatchesExpected, authenticatedRelease: false,
    },
    prerequisites: { macOS: platform === 'darwin', node: major > 22 || (major === 22 && minor >= 12), ...tools },
    build: { present: missingBuild.length === 0, missing: missingBuild, provenanceVerified: false },
    setup: await inspectSetup(repo, now),
    guidedUrl, browserVerified: false, passkeyVerified: false,
    capabilities: { guardianRecovery: 'live-wallet-confirmation', guidedWithdrawal: 'demonstration' },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, expectedRevision, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) throw new Error('Usage: node inspect.mjs CHECKOUT [EXPECTED_COMMIT]');
    console.log(JSON.stringify(await inspectCheckout(repo, { expectedRevision }), null, 2));
  } catch (error) {
    // Filesystem/JSON/Git errors can contain local data; keep unexpected failures generic.
    const message = error.code || error instanceof SyntaxError
      ? 'Cannot inspect this checkout. Verify its path and local files.' : error.message;
    console.error(message);
    process.exitCode = 1;
  }
}
