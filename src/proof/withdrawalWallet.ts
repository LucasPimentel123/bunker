import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type EIP1193Provider } from "viem";
import { walletAccounts } from "../core/walletAccount";
export async function readPayerAccount(provider: EIP1193Provider, expected?: Address): Promise<Address> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accounts = walletAccounts(await Promise.race([
      provider.request({ method: "eth_accounts" }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("A carteira não respondeu. Reconecte e tente novamente.")), 8000); }),
    ]));
    if (!accounts[0]) throw new Error("Conecte a carteira que pagará as taxas.");
    if (expected && !isAddressEqual(accounts[0], expected)) throw new Error("A conta da carteira mudou. Confira o pagador e tente novamente.");
    return accounts[0];
  } finally { clearTimeout(timer); }
}

export function destinationError(snapshot: { address: Address; recoveries: readonly { guardians: readonly Address[] }[] }, value: string): string | undefined {
  if (!value) return;
  if (!isAddress(value)) return "Informe um endereço de destino válido.";
  const address = getAddress(value);
  if (isAddressEqual(address, zeroAddress)) return "O endereço zero não pode receber a retirada.";
  if (isAddressEqual(address, snapshot.address)) return "Escolha um destino diferente da conta de origem.";
  if (snapshot.recoveries.some(recovery => recovery.guardians.some(guardian => isAddressEqual(guardian, address)))) return "O guardian não pode ser o destino da retirada. Use outra carteira.";
}
