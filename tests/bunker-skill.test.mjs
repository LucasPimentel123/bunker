import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectCheckout } from '../skills/bunker/scripts/inspect.mjs';

const id = 'ab'.repeat(32);
const now = Date.UTC(2026, 9, 26);

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'bunker-skill-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('remote', 'add', 'origin', 'https://github.com/usePicnic/bunker.git');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: '@usepicnic/bunker', scripts: { 'bunker:build': 'fixture', 'bunker:setup': 'fixture' } }));
  await writeFile(join(repo, '.gitignore'), '.local-proof/\nbunker-dist/\n');
  git('add', '.');
  git('-c', 'user.name=Bunker Test', '-c', 'user.email=bunker@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const execute = (command, args) => {
    if (command === 'git') return git(...args);
    if (command === 'npm' || command === 'openssl') return 'available';
    assert.fail(`Unexpected command: ${command}`);
  };
  const inspect = options => inspectCheckout(repo, { execute, now, platform: 'darwin', nodeVersion: '22.12.0', ...options });
  const dir = join(repo, '.local-proof/setup-bunker');
  async function setup(state = {}, plan = {}) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'setup.json'), JSON.stringify({
      version: 2, hostname: 'bunker.usepicnic.com', id,
      rootFingerprint: Array(32).fill('AB').join(':'), validTo: '2026-10-30T00:00:00Z', ...plan,
    }));
    await writeFile(join(dir, 'state.json'), JSON.stringify({ trustAttempted: false, hostsAttempted: false, installed: false, ...state }));
    for (const name of ['root.pem', 'cert.pem', 'key.pem', 'review.md']) await writeFile(join(dir, name), 'test material, not a certificate');
  }
  return { repo, git, revision, inspect, dir, setup };
}

test('a fresh checkout reports prerequisites and missing build without changing files', async t => {
  const { repo, inspect, revision, git } = await fixture(t);
  const before = await readdir(repo);
  const result = await inspect({ expectedRevision: revision });
  assert.equal(result.source.revision, revision);
  assert.equal(result.source.modified, false);
  assert.equal(result.source.remoteMatchesExpected, true);
  assert.equal(result.source.authenticatedRelease, false);
  assert.equal(result.setup.state, 'absent');
  assert.equal(result.build.present, false);
  assert.ok(result.build.missing.includes('designs/assets/runtime/guided-wallet.js'));
  assert.deepEqual(result.prerequisites, { macOS: true, node: true, npm: true, openssl: true });
  assert.deepEqual(await readdir(repo), before);
  assert.equal(git('status', '--porcelain'), '');
});

test('prepared installation exposes the actual approval identifier without claiming system verification', async t => {
  const { inspect, setup, dir } = await fixture(t);
  await setup();
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  const result = await inspect();
  assert.equal(result.setup.state, 'prepared');
  assert.equal(result.setup.fingerprint, id);
  assert.equal(result.setup.review, join(dir, 'review.md'));
  assert.equal(result.setup.systemVerified, false);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
});

test('installed state stays separate from browser, passkey and build provenance checks', async t => {
  const { repo, inspect, setup } = await fixture(t);
  await setup({ trustAttempted: true, hostsAttempted: true, installed: true });
  for (const file of (await inspect()).build.missing) {
    const path = join(repo, 'bunker-dist', file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  const result = await inspect();
  assert.equal(result.setup.state, 'installed');
  assert.equal(result.build.present, true);
  assert.equal(result.build.provenanceVerified, false);
  assert.equal(result.browserVerified, false);
  assert.equal(result.passkeyVerified, false);
  assert.equal(result.capabilities.guardianRecovery, 'live-wallet-confirmation');
  assert.equal(result.capabilities.guidedWithdrawal, 'demonstration');
});

test('interrupted trust or hosts mutations and operation locks never become a fresh install', async t => {
  const { inspect, setup, dir } = await fixture(t);
  for (const state of [{ trustAttempted: true }, { trustAttempted: true, hostsAttempted: true }]) {
    await setup(state);
    assert.equal((await inspect()).setup.state, 'interrupted');
  }
  await setup({ trustAttempted: true, installed: true });
  await writeFile(join(dir, '.operation.lock'), JSON.stringify({ pid: 123 }));
  assert.equal((await inspect()).setup.state, 'interrupted');
});

test('expired and malformed installations are reported without removing their state', async t => {
  const { inspect, setup, dir } = await fixture(t);
  await setup({ trustAttempted: true, installed: true }, { validTo: '2026-10-25T00:00:00Z' });
  assert.equal((await inspect()).setup.state, 'expired');
  await writeFile(join(dir, 'setup.json'), 'SECRET_SENTINEL_NOT_REAL');
  const result = await inspect();
  assert.equal(result.setup.state, 'invalid');
  assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL_NOT_REAL'));
  assert.equal(await readFile(join(dir, 'setup.json'), 'utf8'), 'SECRET_SENTINEL_NOT_REAL');
});

test('rejects conflicting identifiers, inconsistent journals and symlinked setup', async t => {
  const { inspect, setup, dir } = await fixture(t);
  await setup({}, { hostname: 'different.example' });
  assert.equal((await inspect()).setup.state, 'invalid');
  await setup({ installed: true });
  assert.equal((await inspect()).setup.state, 'invalid');
  await rm(dir, { recursive: true });
  const other = join(dirname(dir), 'other');
  await mkdir(other);
  await symlink(other, dir);
  assert.equal((await inspect()).setup.state, 'invalid');
});

test('detects source drift and does not expose credentials from a remote URL', async t => {
  const { repo, inspect, git } = await fixture(t);
  await assert.rejects(inspect({ expectedRevision: '00'.repeat(20) }), /revision changed/);
  await writeFile(join(repo, 'unreviewed.txt'), 'changed');
  git('remote', 'set-url', 'origin', 'https://SECRET_SENTINEL_NOT_REAL@github.com/usePicnic/bunker.git');
  const result = await inspect();
  assert.equal(result.source.modified, true);
  assert.equal(result.source.remoteMatchesExpected, false);
  assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL_NOT_REAL'));
});

test('reports unsupported hosts and missing prerequisites without installing anything', async t => {
  const { inspect, git } = await fixture(t);
  const result = await inspect({ platform: 'linux', nodeVersion: '22.11.0', execute(command, args) {
    if (command === 'git') return git(...args);
    throw new Error('not installed');
  } });
  assert.deepEqual(result.prerequisites, { macOS: false, node: false, npm: false, openssl: false });
  assert.equal(result.setup.state, 'absent');
});

test('rejects an unrelated repository before inspecting setup or running package commands', async t => {
  const { repo, inspect } = await fixture(t);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'unrelated' }));
  await assert.rejects(inspect(), /not a Bunker/);
});

for (const layout of ['.agents/skills/bunker', '.claude/skills/bunker', 'local-agent/instructions/bunker']) {
  test(`portable skill runs from ${layout} without vendor adapters or environment`, async t => {
    const { repo, revision } = await fixture(t);
    const installed = await mkdtemp(join(tmpdir(), 'bunker-installed-skill-'));
    t.after(() => rm(installed, { recursive: true, force: true }));
    const destination = join(installed, layout);
    await cp(new URL('../skills/bunker', import.meta.url), destination, { recursive: true });
    await rm(join(destination, 'agents'), { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(CODEX|CLAUDE|OPENAI|ANTHROPIC)(_|$)/.test(name)));
    const output = execFileSync(process.execPath, [join(destination, 'scripts/inspect.mjs'), repo, revision], {
      cwd: installed, env, encoding: 'utf8', timeout: 20_000,
    });
    const result = JSON.parse(output);
    assert.equal(result.source.revision, revision);
    assert.equal(result.source.modified, false);
    assert.equal(result.setup.state, 'absent');
    assert.equal(result.guidedUrl, 'https://bunker.usepicnic.com:8443/designs/guided.html?design=segments');
    // A copied folder keeps the license and all skill-relative resources usable.
    const skill = await readFile(join(destination, 'SKILL.md'), 'utf8');
    for (const [, relative] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
      assert.ok((await readFile(join(destination, relative), 'utf8')).length > 0);
    }
    assert.equal(await readFile(join(destination, 'LICENSE.txt'), 'utf8'),
      await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
  });
}
