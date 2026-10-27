import { concat, encodeAbiParameters, encodeFunctionData, getAddress, getCreate2Address, keccak256, pad, parseAbi, toHex, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import deployments from "../catalog/account-discovery.json";
import { same } from "./client";
import { inspectAccount, assertSupportedSafe, recoveryPeriod, SAFE_SINGLETONS } from "./inspect";
import { inspectCard, proxyImplementation } from "./card";
import { ReadPool } from "./reads";

const setupAbi = parseAbi(["function setup(address[],uint256,address,bytes,address,address,uint256,address)", "function enableModules(address[])"]);
function predict(owner: Address, card: boolean): Address {
  const deployment = card ? deployments.card : deployments.picnic;
  const initializer = encodeFunctionData({ abi: setupAbi, functionName: "setup", args: [[owner], 1n,
    card ? zeroAddress : deployments.picnic.addModulesLibAddress as Address,
    card ? "0x" : encodeFunctionData({ abi: setupAbi, functionName: "enableModules", args: [[deployments.picnic.safe4337ModuleAddress as Address]] }),
    (card ? deployments.card.fallbackHandler : deployments.picnic.safe4337ModuleAddress) as Address, zeroAddress, 0n, zeroAddress] });
  return getCreate2Address({ from: deployment.safeProxyFactoryAddress as Address,
    salt: keccak256(concat([keccak256(initializer), card ? keccak256(stringToHex("gnosispay.com")) : encodeAbiParameters([{ type: "uint256" }], [0n])])),
    bytecode: concat([deployment.proxyCreationCode as Hex, encodeAbiParameters([{ type: "address" }], [deployment.safeSingletonAddress as Address])]) });
}
// Matches Picnic's original EOA-owner Safe deployment. Prediction is only a hint;
// current singleton/runtime and ownership must be verified before selecting it.
export const predictPicnicAccount = (owner: Address) => predict(owner, false);
export const predictCardAccount = (controller: Address) => predict(controller, true);
export async function discoverPicnicAccount(pool: ReadPool, owner: Address) {
  const candidate = predictPicnicAccount(owner);
  const code = await pool.run(client => client.getCode({ address: candidate }), `code:${candidate.toLowerCase()}`);
  if (!code || code === "0x") return;
  const snapshot = await pool.run(client => inspectAccount(client, candidate, 100));
  assertSupportedSafe(snapshot);
  if (!snapshot.owners.some(address => same(address, owner))) return;
  return candidate;
}

// Events are address hints, never authority. Query indexed topics so this works
// without Picnic/Candide APIs. An indexed address[] hashes its padded elements
// without the ABI array offset or length; this flow supports one new owner.
export const guardianAddedTopic = keccak256(stringToHex("GuardianAdded(address,address)"));
export const recoveryFinalizedTopic = keccak256(stringToHex("RecoveryFinalized(address,address[],uint256,uint256)"));
export const recoveredOwnerTopic = (owner: Address) => keccak256(pad(owner, { size: 32 }));
export type RecoveryHandoff = { account: Address; chainId: number; newOwner: Address };
// A successful recovery can finish on another network before Gnosis. A hint
// retains the account identity, not its authority: prove current ownership on
// that network again, and never apply it to a different connected wallet.
export async function verifyRecoveryHandoff(pool: ReadPool, wallet: Address, handoff: RecoveryHandoff): Promise<Address | undefined> {
  if (!same(wallet, handoff.newOwner)) return;
  const snapshot = await pool.run(client => inspectAccount(client, handoff.account, handoff.chainId));
  assertSupportedSafe(snapshot);
  return snapshot.owners.some(owner => same(owner, wallet)) ? handoff.account : undefined;
}
export async function discoverRecoveryAccounts(pool: ReadPool, wallet: Address, chainId = 100): Promise<Address[]> {
  const queries = [
    { event: guardianAddedTopic, identity: pad(wallet, { size: 32 }), role: "guardian" },
    { event: recoveryFinalizedTopic, identity: recoveredOwnerTopic(wallet), role: "owner" },
  ] as const;
  const candidates = new Map<string, { account: Address; module: Address; roles: Set<string> }>();
  for (const query of queries) {
    const logs = await pool.run(client => client.request({ method: "eth_getLogs", params: [{
      fromBlock: "0x0", toBlock: "latest", topics: [query.event, null, query.identity],
    }] }));
    // Do not silently truncate a history scan or choose an arbitrary account.
    if (logs.length >= 2000) throw new Error("Recovery discovery history limit reached; accounts could not be fully verified");
    for (const log of logs) {
      if (log.removed || log.topics[0]?.toLowerCase() !== query.event.toLowerCase()
        || log.topics[2]?.toLowerCase() !== query.identity.toLowerCase() || !/^0x0{24}[a-f0-9]{40}$/i.test(log.topics[1] ?? "")) continue;
      const account = getAddress(`0x${log.topics[1]!.slice(-40)}`), module = getAddress(log.address);
      const key = `${account.toLowerCase()}:${module.toLowerCase()}`;
      const candidate = candidates.get(key) ?? { account, module, roles: new Set<string>() };
      candidate.roles.add(query.role); candidates.set(key, candidate);
      if (candidates.size > 64) throw new Error("Recovery discovery candidate limit reached; accounts could not be fully verified");
    }
  }
  const modules = new Map<string, boolean>();
  const found = new Map<string, Address>();
  for (const candidate of candidates.values()) {
    pool.throwIfAborted();
    const moduleKey = candidate.module.toLowerCase();
    if (!modules.has(moduleKey)) {
      const code = await pool.run(client => client.getCode({ address: candidate.module }));
      modules.set(moduleKey, recoveryPeriod(code) !== undefined);
    }
    if (!modules.get(moduleKey)) continue;
    const snapshot = await pool.run(client => inspectAccount(client, candidate.account, chainId));
    assertSupportedSafe(snapshot);
    // The emitting canonical module must still be enabled on this exact Safe.
    const recovery = snapshot.recoveries.find(r => r.supported && same(r.module, candidate.module));
    if (!recovery) continue;
    const owner = candidate.roles.has("owner") && snapshot.owners.some(value => same(value, wallet));
    const guardian = candidate.roles.has("guardian") && recovery.threshold > 0n && recovery.guardians.some(value => same(value, wallet));
    if (owner || guardian) found.set(candidate.account.toLowerCase(), candidate.account);
  }
  return [...found.values()];
}
// Gnosis Pay's v5 Delay emits EnabledModule(address) with a NON-indexed
// controller. Filtering topic[1] would silently miss these events. Read bounded
// block pages, filter their data locally, then verify the emitter and live wiring.
// ABI: https://github.com/gnosispay/account-kit/blob/main/contracts/interfaces/IDelayModifier.sol
export const cardControllerTopic = keccak256(stringToHex("EnabledModule(address)"));
const cardV5Implementation = "0x22d903fd45f441f51bcad198d14eba8a75ea1ef0";
type CardHistory = { head?: bigint; cursor?: bigint; span?: bigint; floor: bigint; modules: Map<string, Address> };
export async function discoverCards(pool: ReadPool, controller: Address, pageBudget = 32) {
  const predicted = predictCardAccount(controller), issues: string[] = [], notes: string[] = [];
  const history = pool.sessionState<CardHistory>(`card-history:${controller.toLowerCase()}`, () => ({ modules: new Map(), floor: 0n }));
  try {
    if (history.head === undefined) {
      const head = await pool.run(client => client.getBlockNumber());
      pool.throwIfAborted(); history.head = head; history.cursor = head; history.span = head + 1n;
    }
    else if (history.cursor! < history.floor) {
      const head = await pool.run(client => client.getBlockNumber());
      pool.throwIfAborted();
      if (head > history.head) { history.floor = history.head + 1n; history.cursor = head; history.span = head - history.head; history.head = head; }
    }
    for (let page = 0; history.cursor! >= history.floor && page < pageBudget; page++) {
      pool.throwIfAborted();
      const end = history.cursor!, lower = end >= history.span! ? end - history.span! + 1n : 0n, from = lower < history.floor ? history.floor : lower;
      try {
        const logs = await pool.run(client => client.request({ method: "eth_getLogs", params: [{
          fromBlock: toHex(from), toBlock: toHex(end), topics: [cardControllerTopic],
        }] }));
        // Providers may truncate at their result limit. Split instead of slicing.
        if (logs.length >= 1000) throw Error("Card event page limit");
        const found: Address[] = [];
        for (const log of logs) {
          if (log.removed) continue;
          if (log.blockNumber === null || BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > end
            || log.topics[0]?.toLowerCase() !== cardControllerTopic.toLowerCase()) throw Error("Card event page mismatch");
          const value = log.topics.length === 1 ? log.data : log.topics.length === 2 && log.data === "0x" ? log.topics[1] : undefined;
          if (!/^0x0{24}[a-f0-9]{40}$/i.test(value ?? "")) throw Error("Malformed card controller event");
          if (same(`0x${value!.slice(-40)}`, controller)) found.push(getAddress(log.address));
        }
        pool.throwIfAborted();
        found.forEach(module => history.modules.set(module.toLowerCase(), module));
        history.cursor = from - 1n;
      } catch {
        pool.throwIfAborted();
        if (history.span! <= 1n) { issues.push("Não foi possível consultar um trecho dos eventos de cartões. Tente novamente para retomar."); break; }
        history.span = (history.span! + 1n) / 2n;
      }
    }
  } catch { pool.throwIfAborted(); issues.push("Histórico de vínculos dos cartões indisponível. Tente novamente."); }
  const incomplete = history.cursor === undefined || history.cursor >= history.floor;
  if (incomplete && !issues.length) issues.push("A busca de cartões ainda não terminou. Continue para consultar os eventos restantes.");
  const addresses = new Map<string, Address>();
  // Predicted original card is a useful hint, but never proof of authority.
  async function verifyCard(candidate: Address, expectedModule?: Address) {
    const code = await pool.run(client => client.getCode({ address: candidate }));
    if (!code || code === "0x" || code.length > 1000) return;
    const singleton = await pool.run(client => client.getStorageAt({ address: candidate, slot: "0x0" }));
    if (!singleton || !SAFE_SINGLETONS.some(address => same(address, `0x${singleton.slice(-40)}`))) {
      if (same(candidate, predicted)) notes.push("O cartão original está fora do escopo v5 suportado.");
      return;
    }
    const delays = (await pool.run(client => inspectCard(client, candidate, pool.chainId)))
      .filter(delay => delay.delayVersion === "v5" && delay.controllers.some(owner => same(owner, controller)));
    if (delays.length === 1 && (!expectedModule || same(delays[0].address, expectedModule))) addresses.set(candidate.toLowerCase(), candidate);
  }
  try { await verifyCard(predicted); }
  catch { pool.throwIfAborted(); issues.push("O cartão original ainda não pôde ser verificado."); }
  const modules = [...history.modules.values()];
  for (let offset = 0; offset < modules.length; offset += 4) await Promise.all(modules.slice(offset, offset + 4).map(async module => {
    try {
      const code = await pool.run(client => client.getCode({ address: module }));
      if (!same(proxyImplementation(code) ?? zeroAddress, cardV5Implementation)) return;
      const avatar = await pool.run(client => client.readContract({ address: module, abi: parseAbi(["function avatar() view returns(address)"]), functionName: "avatar" }));
      await verifyCard(avatar, module);
    } catch {
      pool.throwIfAborted();
      if (!issues.includes("Alguns vínculos de cartões ainda não puderam ser verificados.")) issues.push("Alguns vínculos de cartões ainda não puderam ser verificados.");
    }
  }));
  return { addresses: [...addresses.values()], issues, notes, incomplete,
    history: { throughBlock: history.head?.toString(), nextBlock: incomplete ? history.cursor?.toString() : undefined } };
}
