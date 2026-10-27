import type { Address } from "viem";
import { chains } from "../catalog/chains";
import { publicClient, same } from "./client";
import { discoverRecoveryAccounts } from "./discovery";
import { ReadPool } from "./reads";
import { discoveryRpc, independentAccountHints } from "./ownerHistory";
import { assertSupportedSafe, inspectAccount } from "./inspect";
// Every external-wallet address hint must prove current owner authority. Guardian
// links are separately discovered and verified through canonical recovery modules.
export async function discoverExternalCandidates(wallet: Address, overrides: Record<number, string>, signal: AbortSignal) {
  const addresses = new Map<string, Address>(), issues: string[] = [];
  const checkAbort = () => signal.throwIfAborted();
  await Promise.all(chains.map(async chain => {
    try {
      checkAbort();
      const rpc = overrides[chain.id] ?? discoveryRpc(chain.id);
      const client = publicClient(chain, rpc, 20_000, signal);
      const [hintResult, recoveryResult] = await Promise.allSettled([
        independentAccountHints(client, chain.id, wallet),
        discoverRecoveryAccounts(new ReadPool(chain, [{ url: rpc }], signal), wallet, chain.id),
      ]);
      checkAbort();
      if (recoveryResult.status === "fulfilled") recoveryResult.value.forEach(account => addresses.set(account.toLowerCase(), account));
      else issues.push(`${chain.name}: histórico de guardian/recovery ainda não verificado.`);
      if (hintResult.status !== "fulfilled") throw hintResult.reason;
      const hints = hintResult.value;
      if (hints.incomplete || hints.issues?.length) issues.push(`${chain.name}: a descoberta pode estar incompleta. Repita para continuar o histórico on-chain.`);
      for (const account of hints.addresses.slice(0, 64)) {
        checkAbort();
        try {
          const snapshot = await inspectAccount(client, account, chain.id);
          assertSupportedSafe(snapshot);
          if (snapshot.owners.some(owner => same(owner, wallet))) addresses.set(account.toLowerCase(), account);
        } catch { issues.push(`${chain.name}: uma conta encontrada ainda não pôde ser verificada.`); }
      }
    } catch { checkAbort(); issues.push(`${chain.name}: descoberta indisponível.`); }
  }));
  return { addresses: [...addresses.values()], issues };
}
