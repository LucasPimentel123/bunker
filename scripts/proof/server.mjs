import https from 'node:https';
import readOrigins from './read-origins.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { HOST, PORT, ORIGIN, BUNKER, BUILD_DIRECTORY } from './profile.mjs';
export { HOST, PORT, ORIGIN } from './profile.mjs';
export const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getStorageAt', 'eth_getTransactionCount', 'eth_call']);
export const WALLETCONNECT_ORIGINS = ['wss://relay.walletconnect.org', 'wss://relay.walletconnect.com', 'https://relay.walletconnect.org', 'https://relay.walletconnect.com', 'https://verify.walletconnect.org', 'https://verify.walletconnect.com'];
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'" + (BUNKER ? " 'unsafe-inline'" : "") + "; connect-src 'self'" + (BUNKER ? ` ${readOrigins.join(' ')} https://api.safe.global ${WALLETCONNECT_ORIGINS.join(' ')}` : "") + "; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; frame-src 'none'";
export function validateRpc(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || /picnic/i.test(url.hostname) || url.username || url.password || url.hash) throw new Error('Use um RPC HTTPS público independente da Picnic, sem credenciais na URL.');
  return url;
}
export function validateRequest(body) {
  // JSON-RPC permits omitted params. Viem omits them for eth_chainId and
  // eth_blockNumber; normalize only absence, never explicit invalid values.
  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || !READ_METHODS.has(body.method) || (body.params !== undefined && !Array.isArray(body.params)) || !(typeof body.id === 'number' || typeof body.id === 'string')) throw new Error('Somente consultas JSON-RPC permitidas.');
  return { jsonrpc: '2.0', id: body.id, method: body.method, params: body.params ?? [] };
}
export function makeHandler({ rpc, root, fetchRpc = fetch }) {
  const upstream = validateRpc(rpc);
  return async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    if (req.headers.host !== `${HOST}:${PORT}`) return fail(421, 'Host local inválido.');
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return fail(403, 'Origem externa bloqueada.');
    try {
      const url = new URL(req.url, ORIGIN);
      if (url.pathname === '/rpc') {
        if (req.method !== 'POST' || req.headers.origin !== ORIGIN || !req.headers['content-type']?.startsWith('application/json')) return fail(403, 'Consulta local apenas.');
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 100_000) return fail(413, 'Consulta muito grande.'); chunks.push(chunk); }
        const body = validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const response = await fetchRpc(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return fail(502, `RPC indisponível (HTTP ${response.status}).`);
        const text = await response.text();
        if (text.length > 2_000_000) return fail(502, 'Resposta RPC muito grande.');
        const result = JSON.parse(text);
        if (result.jsonrpc !== '2.0' || result.id !== body.id || !('result' in result || 'error' in result)) return fail(502, 'Resposta RPC inválida.');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (req.method !== 'GET') return fail(405, 'Método bloqueado.');
      if (url.pathname === '/config') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ origin: ORIGIN, rpId: 'usepicnic.com', rpcHost: upstream.hostname, readOnly: true })); return; }
      const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
      if (relative(root, file).startsWith('..') || file === root) return fail(404, 'Arquivo não encontrado.');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
      if (!types[extname(file)]) return fail(404, 'Arquivo não encontrado.');
      const contents = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] }); res.end(contents);
    } catch (error) { fail(400, error.name === 'TimeoutError' ? 'RPC excedeu 30 segundos. Tente novamente.' : 'Consulta falhou. Verifique o RPC e os parâmetros; nenhuma transação foi enviada.'); }
  };
}
export async function serveProof(rpc, { root = resolve(BUILD_DIRECTORY), tlsDir = resolve('.local-proof') } = {}) {
  validateRpc(rpc);
  await readFile(resolve(root, 'index.html'));
  const server = https.createServer({ key: await readFile(resolve(tlsDir, 'key.pem')), cert: await readFile(resolve(tlsDir, 'cert.pem')) }, makeHandler({ rpc, root }));
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.listen(PORT, '127.0.0.1');
  await once(server, 'listening');
  console.log(`Prova local: ${ORIGIN}\nSomente leitura; RPC: ${validateRpc(rpc).hostname}. Ctrl+C encerra o servidor.`);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rpc = process.argv[2];
  if (!rpc) throw new Error('Uso: npm run proof:serve -- https://RPC-INDEPENDENTE');
  await serveProof(rpc);
}
