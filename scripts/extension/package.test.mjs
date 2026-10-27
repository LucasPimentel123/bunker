import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditExtension } from './package.mjs';

test('built extension ships only packaged UI and narrow passkey/RPC permissions', () => {
  assert.ok(auditExtension(resolve('extension-dist')).includes('manifest.json'));
});
test('packaging refuses expanded permissions, remote scripts, private material and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'picnic-extension-package-'));
  try {
    for (const [index, mutate] of [
      async root => { const path = join(root, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.host_permissions.push('<all_urls>'); await writeFile(path, JSON.stringify(manifest)); },
      async root => { const path = join(root, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.permissions = ['storage', 'scripting']; await writeFile(path, JSON.stringify(manifest)); },
      async root => { const path = join(root, 'index.html'); await writeFile(path, (await readFile(path, 'utf8')).replace('</head>', '<script src="https://example.com/evil.js"></script></head>')); },
      async root => { await writeFile(join(root, 'key.pem'), 'never package TLS keys'); },
      async root => { await writeFile(join(root, 'assets/extra.js'), '-----BEGIN PRIVATE KEY-----'); },
      async root => { await symlink('/etc/hosts', join(root, 'hosts')); },
    ].entries()) {
      const root = join(dir, String(index)); await cp(resolve('extension-dist'), root, { recursive: true });
      await mutate(root); assert.throws(() => auditExtension(root));
    }
  } finally { await rm(dir, { recursive: true }); }
});
