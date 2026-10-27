import { decodeEventLog, getAddress, keccak256, parseAbi, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";
import { assertChain, same } from "./client";
import { predictPicnicAccount } from "./discovery";
import { lookupSafeHints, type AccountHints } from "../extension/accountIndex";
import { chainById, defaultReadRpcs } from "../catalog/chains";

// Discovery needs addressless event queries. Keep its endpoint selection
// separate from the normal app's balance reads and transaction configuration.
export const discoveryRpc = (chainId: number) => chainId === 1 ? "https://eth.drpc.org" : defaultReadRpcs(chainById(chainId))[0];

const abi = parseAbi([
  "event AddedOwner(address owner)",
  "event SafeSetup(address indexed initiator,address[] owners,uint256 threshold,address initializer,address fallbackHandler)",
]);
const topics = [keccak256(stringToHex("AddedOwner(address)")), keccak256(stringToHex("SafeSetup(address,address[],uint256,address,address)"))];
type History = { head: bigint; cursor: bigint; span: bigint; addresses: Map<string, Address> };
// Public hints only, in memory. Never persist assertions. Completed ranges are
// checkpointed so retry continues backwards rather than replaying from the tip.
export function createOwnerHistoryScanner() {
  const histories = new Map<string, History>();
  return async (client: PublicClient, chainId: number, owner: Address, progress: (text: string) => void = () => {}, pages = 8): Promise<AccountHints> => {
    await assertChain(client, chainId);
    const key = `${chainId}:${owner.toLowerCase()}`;
    let history = histories.get(key);
    if (!history) {
      const head = await client.getBlockNumber();
      history = { head, cursor: head, span: 20_000n, addresses: new Map() };
      if (histories.size >= 128) histories.delete(histories.keys().next().value!);
      histories.set(key, history);
    }
    // Failed ranges never advance the cursor. A provider's range/result limit
    // shrinks the window; an unresolved smallest window remains explicitly partial.
    let requests = 0;
    while (history.cursor >= 0n && requests++ < pages) {
      const from = history.cursor >= history.span ? history.cursor - history.span + 1n : 0n;
      progress(`Histórico on-chain: blocos ${from}–${history.cursor}. A busca pode ser retomada sem assinar.`);
      try {
        const logs = await client.request({ method: "eth_getLogs", params: [{ fromBlock: toHex(from), toBlock: toHex(history.cursor), topics: [topics] }] });
        if (logs.length >= 1000) throw new Error("History result limit");
        // Validate the whole page before advancing; malformed provider results
        // cannot silently become an empty, fully scanned range.
        const found: Address[] = [];
        for (const log of logs) {
          if (log.removed) continue;
          if (log.blockNumber === null || BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > history.cursor) throw new Error("History range mismatch");
          const event = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
          const matches = event.eventName === "AddedOwner" ? same(event.args.owner, owner) : event.args.owners.some(value => same(value, owner));
          if (matches) found.push(getAddress(log.address));
        }
        if (new Set([...history.addresses.keys(), ...found.map(a => a.toLowerCase())]).size > 64) return { addresses: [...history.addresses.values()], incomplete: true, issues: ["Limite de contas candidatas atingido; histórico não foi marcado como completo."] };
        found.forEach(address => history!.addresses.set(address.toLowerCase(), address));
        history.cursor = from - 1n;
        if (found.length) break; // Verify current authority before searching older history.
      } catch (error) {
        if (history.span <= 100n) return { addresses: [...history.addresses.values()], incomplete: true, issues: ["O RPC não conseguiu ler este trecho do histórico. A posição foi preservada para tentar novamente."] };
        history.span = history.span / 2n < 100n ? 100n : history.span / 2n;
      }
    }
    return { addresses: [...history.addresses.values()], incomplete: history.cursor >= 0n,
      issues: history.cursor >= 0n ? [`Histórico parcial: ${history.head - history.cursor} blocos consultados. Próximo trecho termina no bloco ${history.cursor}; repita para continuar.`] : [] };
  };
}
const scanHistory = createOwnerHistoryScanner();
export async function independentAccountHints(client: PublicClient, chainId: number, owner: Address, progress: (text: string) => void = () => {},
  index: typeof lookupSafeHints = lookupSafeHints, history = scanHistory): Promise<AccountHints> {
  await assertChain(client, chainId);
  const addresses = new Map<string, Address>();
  const issues: string[] = [];
  const predicted = predictPicnicAccount(owner);
  try {
    const code = await client.getCode({ address: predicted });
    if (code && code !== "0x") addresses.set(predicted.toLowerCase(), predicted);
  } catch { issues.push("Endereço calculado localmente ainda não pôde ser consultado."); }
  let indexed: AccountHints | undefined;
  try { indexed = await index(chainId, owner, fetch, progress); indexed.addresses.forEach(a => addresses.set(a.toLowerCase(), a)); }
  catch { issues.push("Índice da Safe indisponível. Usando descoberta diretamente na blockchain."); }
  if (!indexed || indexed.incomplete || !indexed.addresses.length) {
    progress("Buscando contas diretamente na blockchain…");
    try {
      const found = await history(client, chainId, owner, progress);
      found.addresses.forEach(a => addresses.set(a.toLowerCase(), a));
      return { addresses: [...addresses.values()], incomplete: found.incomplete, issues: [...issues, ...found.issues ?? []] };
    } catch { return { addresses: [...addresses.values()], incomplete: true, issues: [...issues, "Histórico on-chain indisponível. Repita para retomar a busca."] }; }
  }
  return { addresses: [...addresses.values()], incomplete: indexed.incomplete, issues };
}
