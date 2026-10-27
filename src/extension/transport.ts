import { createPublicClient, custom } from "viem";
import networks from "../../extension/networks.json";

export const extensionNetworks = networks;
export const READ_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_call", "eth_getLogs"]);
const LIMIT = 2_000_000;

export async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("RPC retornou uma resposta vazia.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) throw new Error("Resposta RPC excedeu o limite da extensão.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function readOnlyProvider(chainId: number, fetchRpc: typeof fetch = fetch) {
  const network = networks.find(network => network.id === chainId);
  if (!network) throw new Error("Escolha uma das redes disponíveis nesta versão da extensão.");
  let nextId = 0;
  return { request: async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    if (!READ_METHODS.has(method) || (params !== undefined && !Array.isArray(params))) throw new Error("Esta extensão permite somente consultas e simulações; não envia transações.");
    const id = ++nextId;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] });
    if (new TextEncoder().encode(body).length > 100_000) throw new Error("Consulta RPC muito grande.");
    // Public RPC backends can briefly disagree on the newest block. Retry the
    // exact read at the same block; never change the snapshot or signing bytes.
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetchRpc(network.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body,
          credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error", signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new Error(`Não foi possível consultar ${network.name}. Confira sua conexão e tente novamente.`);
      }
      if (!response.ok) throw new Error(`RPC de ${network.name} indisponível (HTTP ${response.status}). Tente novamente.`);
      const value = await readResponse(response);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resposta RPC inválida.");
      const result = value as Record<string, unknown>;
      if (result.jsonrpc !== "2.0" || result.id !== id || Object.hasOwn(result, "result") === Object.hasOwn(result, "error")) throw new Error("Resposta RPC não corresponde à consulta.");
      if (Object.hasOwn(result, "error")) {
        const error = result.error as { code?: unknown; message?: unknown } | null;
        if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") throw new Error("Erro RPC inválido.");
        if (error.code === -32000 && /^(header not found|unknown block)$/i.test(error.message) && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
          continue;
        }
        throw Object.assign(new Error(error.message.slice(0, 500)), { code: error.code });
      }
      return result.result;
    }
    throw new Error("Não foi possível consultar o bloco selecionado.");
  } };
}

export function extensionClient(chainId: number) {
  return createPublicClient({ ccipRead: false, cacheTime: 0, transport: custom(readOnlyProvider(chainId), { retryCount: 0 }) });
}
