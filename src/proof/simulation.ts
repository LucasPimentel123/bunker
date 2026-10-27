import { decodeFunctionResult, encodeFunctionData, getAddress, isAddressEqual, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { assertActionShape, assertAllowedRecipients } from "../core/actions";
import { verifyMultiSendRuntime } from "../core/multisend";
import type { AccountSnapshot, PreparedAction } from "../core/types";
import signerHashes from "./signer-codehashes.json";
import { localSafeHash, type SafeHashArgs } from "../core/safeHash";
import { safeAbi } from "../core/abi";
import { assertSupportedSafe, inspectAccount } from "../core/inspect";
import { isPasskeySigner } from "../core/passkey";
import { contractSignature, signerConfiguration } from "./passkey";

export const signatureAbi = parseAbi(["function isValidSignature(bytes32 message,bytes signature) view returns (bytes4)"]);
const nonceSlot = toHex(5, { size: 32 });
export async function diagnose(client: PublicClient, safe: Address, chainId: number) {
  const snapshot = await inspectAccount(client, safe, chainId);
  assertSupportedSafe(snapshot);
  if (snapshot.threshold !== 1n) throw new Error("Esta prova suporta Safe com threshold 1. Não altere o threshold para executar o teste.");
  const candidates = await Promise.all(snapshot.owners.map(async address => ({ address, code: await client.getCode({ address, blockNumber: snapshot.block }) })));
  const signers = candidates.filter((v): v is { address: Address; code: Hex } => !!v.code && isPasskeySigner(v.code)).map(v => ({ address: v.address, ...signerConfiguration(v.code) }));
  for (const signer of signers) {
    const code = await client.getCode({ address: signer.singleton, blockNumber: snapshot.block });
    const expected = signerHashes[signer.version as keyof typeof signerHashes];
    if (!code || !expected || keccak256(code) !== expected) throw new Error("Implementação do signer WebAuthn não corresponde ao bytecode verificado.");
  }
  if (!signers.length) throw new Error("Esta Safe não tem um signer passkey reconhecido entre os owners.");
  return { snapshot, signers };
}
export type Diagnosis = Awaited<ReturnType<typeof diagnose>>;
export async function verifyOnChain(client: PublicClient, signer: Address, challenge: Hex, signature: Hex, blockNumber: bigint) {
  const magic = await client.readContract({ address: signer, abi: signatureAbi, functionName: "isValidSignature", args: [challenge, signature], blockNumber });
  if (magic !== "0x1626ba7e") throw new Error("O signer on-chain recusou a assinatura da passkey.");
}
export type Withdrawal = { recipient: Address; payer: Address; amount: bigint };
export async function prepareSimulation(client: PublicClient, diagnosis: Diagnosis, signer: Address, withdrawal: Withdrawal) {
  const { snapshot } = diagnosis;
  // Pin every read/call to the same block. The isolated proof never broadcasts.
  if (!diagnosis.signers.some(v => isAddressEqual(v.address, signer))) throw new Error("Signer fora da Safe.");
  const recipient = getAddress(withdrawal.recipient), payer = getAddress(withdrawal.payer);
  if (withdrawal.amount <= 0n || recipient === zeroAddress || payer === zeroAddress || isAddressEqual(recipient, snapshot.address) || isAddressEqual(payer, snapshot.address)) throw new Error("Informe valor positivo, destino distinto da Safe e pagador externo válido.");
  if (snapshot.recoveries.some(r => r.guardians.some(g => isAddressEqual(g, recipient)))) throw new Error("O guardian não pode ser o destino.");
  const payerCode = await client.getCode({ address: payer, blockNumber: snapshot.block });
  if (payerCode && payerCode !== "0x") throw new Error("Use um endereço EOA externo como pagador nesta prova.");
  const actualSlot = await client.getStorageAt({ address: snapshot.address, slot: nonceSlot, blockNumber: snapshot.block });
  if (BigInt(actualSlot ?? "0x0") !== snapshot.nonce) throw new Error("Layout de nonce não reconhecido. Simulação interrompida.");
  if (snapshot.nonce >= 1n << 128n) throw new Error("Nonce inesperado para esta prova.");
  const random = crypto.getRandomValues(new Uint8Array(16));
  const nonce = (1n << 255n) + BigInt(toHex(random));
  const to = recipient, value = withdrawal.amount, data = "0x" as Hex;
  if (value > snapshot.nativeBalance) throw new Error("A Safe não tem saldo nativo suficiente para esta simulação.");
  const args = Object.freeze([to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const);
  const challenge = localSafeHash(snapshot.chainId, snapshot.address, args, nonce);
  return Object.freeze({ snapshot: Object.freeze({ ...snapshot }), signer,
    withdrawal: Object.freeze({ ...withdrawal, recipient, payer }), args, nonce, challenge });
}
export type Simulation = Awaited<ReturnType<typeof prepareSimulation>>;
// Recheck locally at the authenticator boundary and before disclosing a signature.
export function simulationChallenge(plan: { nonce: bigint; snapshot: Pick<AccountSnapshot, "nonce" | "chainId" | "address">; args: SafeHashArgs; challenge: Hex }): Hex {
  if (plan.nonce < 1n << 255n || plan.nonce >= (1n << 255n) + (1n << 128n) || plan.snapshot.nonce >= 1n << 128n) throw new Error("Nonce inválido para a prova de simulação.");
  const expected = localSafeHash(plan.snapshot.chainId, plan.snapshot.address, plan.args, plan.nonce);
  if (expected !== plan.challenge) throw new Error("O hash não corresponde à transação montada localmente.");
  return expected;
}
export async function simulateWithdrawal(client: PublicClient, plan: Simulation, signature: Hex) {
  const challenge = simulationChallenge(plan);
  await verifyOnChain(client, plan.signer, challenge, signature, plan.snapshot.block);
  const { data } = await client.call({
    account: plan.withdrawal.payer, to: plan.snapshot.address, blockNumber: plan.snapshot.block,
    data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...plan.args, contractSignature(plan.signer, signature)] }),
    stateOverride: [{ address: plan.snapshot.address, stateDiff: [{ slot: nonceSlot, value: toHex(plan.nonce, { size: 32 }) }] }],
  });
  if (!data || !decodeFunctionResult({ abi: safeAbi, functionName: "execTransaction", data })) throw new Error("A execução da Safe falhou na simulação.");
  return { chainId: plan.snapshot.chainId, block: plan.snapshot.block.toString(), safe: plan.snapshot.address, signer: plan.signer, payer: plan.withdrawal.payer,
    recipient: plan.withdrawal.recipient, token: "native", amount: plan.withdrawal.amount.toString(),
    result: "safe-execution-simulated" as const, nonceOverrideOnly: true, broadcast: false };
}

// Reuse the recovery planner's exact CALL/MultiSend payload. The proof keeps a
// reserved nonce and cannot broadcast a live authorization. No owner overrides.
export async function prepareActionSimulation(client: PublicClient, diagnosis: Diagnosis, signer: Address, action: PreparedAction, payer: Address) {
  const snapshot = diagnosis.snapshot;
  assertActionShape(action);
  if (action.kind !== "safe" || action.chainId !== snapshot.chainId || !isAddressEqual(action.account, snapshot.address) || action.safeNonce !== snapshot.nonce) throw new Error("Plano não corresponde à Safe atual.");
  if (!diagnosis.signers.some(owner => isAddressEqual(owner.address, signer))) throw new Error("A passkey não controla esta Safe.");
  assertAllowedRecipients(action, [...action.forbiddenRecipients ?? [], ...snapshot.recoveries.flatMap(r => r.guardians)]);
  if (action.operation === 1) await verifyMultiSendRuntime(client, action.chainId, action.call.to);
  await action.revalidate?.();
  if (payer === zeroAddress || isAddressEqual(payer, snapshot.address)) throw new Error("Conecte um pagador externo válido.");
  const code = await client.getCode({ address: payer, blockNumber: snapshot.block });
  if (code && code !== "0x") throw new Error("Use uma EOA externa como pagador nesta prova.");
  const slot = await client.getStorageAt({ address: snapshot.address, slot: nonceSlot, blockNumber: snapshot.block });
  if (BigInt(slot ?? "0x0") !== snapshot.nonce || snapshot.nonce >= 1n << 128n) throw new Error("Nonce incompatível com a prova.");
  const nonce = (1n << 255n) + BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
  const args = Object.freeze([action.call.to, action.call.value, action.call.data, action.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const);
  const challenge = localSafeHash(snapshot.chainId, snapshot.address, args, nonce);
  return Object.freeze({ snapshot: Object.freeze({ ...snapshot }), signer, payer, args, nonce, challenge });
}
export async function simulateAction(client: PublicClient, plan: Awaited<ReturnType<typeof prepareActionSimulation>>, signature: Hex) {
  const challenge = simulationChallenge(plan);
  await verifyOnChain(client, plan.signer, challenge, signature, plan.snapshot.block);
  const { data } = await client.call({ account: plan.payer, to: plan.snapshot.address, blockNumber: plan.snapshot.block,
    data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...plan.args, contractSignature(plan.signer, signature)] }),
    stateOverride: [{ address: plan.snapshot.address, stateDiff: [{ slot: nonceSlot, value: toHex(plan.nonce, { size: 32 }) }] }],
  });
  if (!data || !decodeFunctionResult({ abi: safeAbi, functionName: "execTransaction", data })) throw new Error("O lote falhou na simulação.");
  return { chainId: plan.snapshot.chainId, safe: plan.snapshot.address, block: plan.snapshot.block.toString(), broadcast: false as const };
}
