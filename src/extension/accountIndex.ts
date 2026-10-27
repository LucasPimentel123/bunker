import { getAddress, type Address } from "viem";
import config from "../../extension/discovery.json";
import { readResponse } from "./transport";

export type AccountHints = { addresses: Address[]; incomplete: boolean; issues?: string[] };
// The index is a discovery hint, never evidence of ownership. Never follow its
// next URL: pagination stays on this fixed origin/path and has a hard bound.
type Progress = (message: string) => void;

// One scheduler across networks in this page; no credentials or assertions are
// cached. A cached index response is still only a hint, checked on-chain later.
export function createSafeIndexLookup(fetchIndex: typeof fetch = fetch) {
  let queue: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;
  let cooldownUntil = 0;
  const cache = new Map<string, { expires: number; value: AccountHints }>();
  const pending = new Map<string, { promise: Promise<AccountHints>; listeners: Set<Progress> }>();
  const limited = () => new Error(`O índice da Safe limitou as consultas (HTTP 429). Aguarde ${Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000))} s e repita a consulta. Sua passkey já foi recebida; não precisa assinar novamente.`);
  async function request(url: string, progress: Progress): Promise<Response> {
    progress("Consulta na fila do índice da Safe…");
    const task = queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Never shorten a server cooldown. Long pauses remain resumable manually.
        if (cooldownUntil - Date.now() > 30_000) throw limited();
        while (Math.max(nextRequestAt, cooldownUntil) > Date.now()) {
          const wait = Math.max(nextRequestAt, cooldownUntil) - Date.now();
          progress(cooldownUntil > Date.now()
            ? `Índice da Safe ocupado. Nova tentativa em ${Math.ceil(wait / 1000)} s…`
            : "Aguardando a próxima consulta ao índice da Safe…");
          await new Promise(resolve => setTimeout(resolve, Math.min(wait, 1000)));
        }
        progress(`Consultando índice da Safe · tentativa ${attempt + 1} de 3…`);
        nextRequestAt = Date.now() + 1000;
        const response = await fetchIndex(url, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20_000) });
        if (response.status !== 429) return response;
        const header = response.headers.get("Retry-After")?.trim();
        const seconds = header && /^\d+$/.test(header) ? Number(header) : NaN;
        const date = header && !/^\d+$/.test(header) ? Date.parse(header) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 5000 * 2 ** attempt;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.max(1000, delay));
        await response.body?.cancel();
        if (attempt === 2) throw limited();
      }
      throw limited();
    });
    queue = task.then(() => undefined, () => undefined);
    return task;
  }
  return async (chainId: number, owner: Address, progress: Progress = () => {}): Promise<AccountHints> => {
    const key = `${chainId}:${getAddress(owner).toLowerCase()}`;
    const saved = cache.get(key);
    if (saved && saved.expires > Date.now()) return { ...saved.value, addresses: [...saved.value.addresses] };
    if (saved) cache.delete(key);
    const existing = pending.get(key);
    if (existing) {
      existing.listeners.add(progress);
      progress("Aguardando consulta já em andamento…");
      try { return await existing.promise; } finally { existing.listeners.delete(progress); }
    }
    const listeners = new Set([progress]);
    const promise = readHints(chainId, owner, url => request(url, message => listeners.forEach(listener => listener(message))));
    pending.set(key, { promise, listeners });
    try {
      const result = await promise;
      if (!result.incomplete && result.addresses.length) {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, { expires: Date.now() + 300_000, value: { ...result, addresses: [...result.addresses] } });
      }
      return result;
    } finally { pending.delete(key); }
  };
}
const clients = new WeakMap<typeof fetch, ReturnType<typeof createSafeIndexLookup>>();
export function lookupSafeHints(chainId: number, owner: Address, fetchIndex: typeof fetch = fetch, progress?: Progress): Promise<AccountHints> {
  let client = clients.get(fetchIndex);
  if (!client) { client = createSafeIndexLookup(fetchIndex); clients.set(fetchIndex, client); }
  return client(chainId, owner, progress);
}
async function readHints(chainId: number, owner: Address, request: (url: string) => Promise<Response>): Promise<AccountHints> {
  const chain = config.chains[String(chainId) as keyof typeof config.chains];
  if (!chain) throw new Error("Rede sem índice de descoberta configurado.");
  const addresses = new Map<string, Address>();
  const pageSize = 100;
  for (let page = 0; page < 3; page++) {
    const url = `${config.origin}/tx-service/${chain}/api/v2/owners/${getAddress(owner)}/safes/?limit=${pageSize}&offset=${page * pageSize}`;
    const response = await request(url);
    if (!response.ok) throw new Error(`Índice público da Safe indisponível (HTTP ${response.status}).`);
    const data = await readResponse(response) as { count?: unknown; next?: unknown; results?: unknown } | null;
    if (!data || !Number.isSafeInteger(data.count) || Number(data.count) < 0 || !Array.isArray(data.results) || data.results.length > pageSize || !(data.next === null || typeof data.next === "string")) throw new Error("Resposta inválida do índice público da Safe.");
    for (const row of data.results) {
      if (!row || typeof row.address !== "string") throw new Error("Endereço inválido no índice da Safe.");
      const address = getAddress(row.address);
      addresses.set(address.toLowerCase(), address);
    }
    const complete = data.next === null && page * pageSize + data.results.length >= Number(data.count);
    if (complete) return { addresses: [...addresses.values()], incomplete: false };
    if (data.results.length < pageSize || page === 2) return { addresses: [...addresses.values()], incomplete: true };
  }
  return { addresses: [...addresses.values()], incomplete: true };
}
