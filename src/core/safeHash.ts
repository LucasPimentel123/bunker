import { hashTypedData, type Address, type Hex } from "viem";

// Safe 1.3.0/1.4.1 encodeTransactionData: domain has only chainId and
// verifyingContract (no name/version). Never accept a signing hash from RPC.
export const safeTypes = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] } as const;

export type SafeHashArgs = readonly [Address, bigint, Hex, 0 | 1, bigint, bigint, bigint, Address, Address];
export function localSafeHash(chainId: number, safe: Address, args: SafeHashArgs, nonce: bigint): Hex {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid Safe chain ID");
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver] = args;
  return hashTypedData({
    domain: { chainId, verifyingContract: safe }, primaryType: "SafeTx", types: safeTypes,
    message: { to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce },
  });
}
