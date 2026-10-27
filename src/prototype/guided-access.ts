import { getAddress } from 'viem';
import { chains } from '../catalog/chains';
import { publicClient, same } from '../core/client';
import { discoveryRpc } from '../core/ownerHistory';
import { assertSupportedSafe, inspectAccount } from '../core/inspect';

// Discovery proves a relationship, not signing authority. This lightweight
// access gate deliberately does not enumerate tokens, investments or baskets.
export async function checkExternalAccess(value: string, walletValue: string, signal: AbortSignal) {
  const account = getAddress(value), wallet = getAddress(walletValue);
  const networks = await Promise.all(chains.map(async chain => {
    const client = publicClient(chain, discoveryRpc(chain.id), 20_000, signal);
    try {
      signal.throwIfAborted();
      const code = await client.getCode({ address: account });
      if (!code || code === '0x') return { chainId: chain.id, name: chain.name, status: 'absent' as const };
      const snapshot = await inspectAccount(client, account, chain.id);
      assertSupportedSafe(snapshot);
      const owner = snapshot.owners.some(a => same(a, wallet));
      const guardian = snapshot.recoveries.some(r => r.supported && r.threshold > 0n && r.guardians.some(a => same(a, wallet)));
      return { chainId: chain.id, name: chain.name,
        status: owner && snapshot.threshold === 1n ? 'owner' as const : guardian ? 'guardian' as const : 'blocked' as const,
        passkey: snapshot.passkey === 'detected', snapshot,
      };
    } catch {
      signal.throwIfAborted();
      return { chainId: chain.id, name: chain.name, status: 'unknown' as const };
    }
  }));
  signal.throwIfAborted();
  const deployed = networks.filter(n => n.status !== 'absent');
  return { account, wallet, ready: deployed.length > 0 && deployed.every(n => n.status === 'owner'), networks };
}
