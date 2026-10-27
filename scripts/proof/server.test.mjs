import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPublicClient, http as viemHttp } from 'viem';
import { makeHandler, validateRequest, validateRpc, ORIGIN, HOST, PORT, CSP, WALLETCONNECT_ORIGINS } from './server.mjs';
import { BUNKER } from './profile.mjs';
import readOrigins from './read-origins.json' with { type: 'json' };
test('Bunker admits catalogue reads and wallet styles without remote scripts or frames', () => {
  const directives = Object.fromEntries(CSP.split(';').map(value => { const [key, ...parts] = value.trim().split(/\s+/); return [key, parts]; }));
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['frame-src'], ["'none'"]);
  assert.deepEqual(directives['font-src'], ["'self'"]);
  assert.deepEqual(directives['style-src'], BUNKER ? ["'self'", "'unsafe-inline'"] : ["'self'"]);
  assert.deepEqual(directives['connect-src'], BUNKER ? ["'self'", ...readOrigins, 'https://api.safe.global', ...WALLETCONNECT_ORIGINS] : ["'self'"]);
});
test('only bounded read RPC methods, no batch/sign/broadcast', () => {
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'wallet_sendCalls', 'anvil_setStorageAt', 'admin_nodeInfo']) assert.throws(() => validateRequest({ jsonrpc: '2.0', id: 1, method, params: [] }));
  assert.throws(() => validateRequest([{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }]));
  assert.equal(validateRequest({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }).method, 'eth_call');
  for (const params of [null, {}, 'invalid', 1]) assert.throws(() => validateRequest({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params }));
  assert.throws(() => validateRequest({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction' }));
});
test('actual viem chain/block requests with omitted params pass through the read-only proxy', async () => {
  const forwarded = [];
  const server = http.createServer(makeHandler({ rpc: 'https://rpc.example.org', root: '/unused', fetchRpc: async (_url, init) => {
    const body = JSON.parse(init.body); forwarded.push(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x89' : '0x1234' }));
  } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const outgoing = [];
  const client = createPublicClient({ transport: viemHttp(`http://127.0.0.1:${server.address().port}/rpc`, {
    retryCount: 0,
    // Node fetch rewrites Host to its ephemeral test port. Preserve the real
    // browser Host/Origin with a test HTTP adapter; viem still builds the body.
    fetchFn: async (_url, init) => {
      outgoing.push(JSON.parse(init.body));
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/rpc', method: 'POST', headers: { host: `${HOST}:${PORT}`, origin: ORIGIN, 'content-type': 'application/json' } }, response => {
          let data = ''; response.on('data', chunk => data += chunk);
          response.on('end', () => resolve(new Response(data, { status: response.statusCode })));
          response.on('error', reject);
        }); req.on('error', reject); req.end(init.body);
      });
    },
  }) });
  try {
    assert.equal(await client.getChainId(), 137);
    assert.equal(await client.getBlockNumber(), 0x1234n);
    assert.deepEqual(outgoing.map(body => body.method), ['eth_chainId', 'eth_blockNumber']);
    assert.ok(outgoing.every(body => !Object.hasOwn(body, 'params')));
    assert.deepEqual(forwarded.map(body => body.params), [[], []]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('rejects Picnic endpoints, cleartext and credential URLs', () => {
  for (const url of ['https://api.usepicnic.com', 'https://usepicnic.com', 'http://rpc.example.org', 'https://user:pass@rpc.example.org']) assert.throws(() => validateRpc(url));
  assert.equal(validateRpc('https://polygon-bor-rpc.publicnode.com').hostname, 'polygon-bor-rpc.publicnode.com');
});
test('serves local static assets with enforced isolation and rejects other origins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'passkey-proof-'));
  await writeFile(join(root, 'index.html'), '<h1>Local proof</h1>');
  let forwarded = 0;
  const server = http.createServer(makeHandler({ rpc: 'https://rpc.example.org', root, fetchRpc: async (_url, init) => {
    forwarded++;
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x89' }));
  } }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  async function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `${HOST}:${PORT}`, ...options.headers } }, response => {
        let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data }));
      }); req.on('error', reject); req.end(options.body);
    });
  }
  try {
    const page = await request('/'); assert.equal(page.status, 200); assert.equal(page.headers['content-security-policy'], CSP);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await request('/', { headers: { host: 'attacker.com' } })).status, 421);
    assert.equal((await request('/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const post = { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) };
    assert.equal((await request('/rpc', post)).status, 200); assert.equal(forwarded, 1);
    assert.equal((await request('/rpc', { ...post, headers: { ...post.headers, origin: 'https://attacker.com' } })).status, 403);
    assert.equal((await request('/rpc', { ...post, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x'] }) })).status, 400);
    assert.equal((await request('/rpc', { ...post, body: 'x'.repeat(100_001) })).status, 413);
    assert.equal(forwarded, 1);
    assert.equal((await request('/%2e%2e/package.json')).status, 404);
    assert.equal((await request('/.local-proof/key.pem')).status, 404);
    assert.equal((await request('/config')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true }); }
});
