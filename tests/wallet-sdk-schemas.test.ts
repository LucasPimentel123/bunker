import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// Exercise the installed SDK schemas, not replicas or mocked wallet providers.
// Their Zod 3 declarations need runtime coverage for the patched Zod override.
const require = createRequire(import.meta.url);
const reownEntry = require.resolve('@reown/appkit-wallet');
const { W3mFrameSchema } = await import(pathToFileURL(
  resolve(dirname(reownEntry), '../src/W3mFrameSchema.js'),
).href);
const coinbaseEntry = require.resolve('@coinbase/cdp-sdk');
const { CreatePolicyBodySchema } = require(resolve(dirname(coinbaseEntry), 'policies/types.js'));
const { SignEvmTypedDataFieldCriterionSchema } = require(resolve(dirname(coinbaseEntry), 'policies/evmSchema.js'));
const address = '0x1111111111111111111111111111111111111111';

describe('wallet SDK compatibility with patched Zod', () => {
  it('parses Reown network and theme messages, preserving optional fields and records', () => {
    const event = { type: '@w3m-app/SYNC_THEME', payload: {
      themeMode: 'light', themeVariables: { '--w3m-z-index': 100, '--w3m-accent': '#c8ff31' },
    } };
    expect(W3mFrameSchema.appEvent.parse(event)).toEqual(event);
    expect(W3mFrameSchema.appEvent.safeParse({ type: '@w3m-app/SWITCH_NETWORK', payload: { chainId: 137 } }).success).toBe(true);
    expect(W3mFrameSchema.appEvent.safeParse({ type: '@w3m-app/SWITCH_NETWORK', payload: { chainId: {} } }).success).toBe(false);
    expect(W3mFrameSchema.appEvent.safeParse({ ...event, payload: { themeMode: 'invalid' } }).success).toBe(false);
  });

  it('validates nested wallet calls and frame responses without making a wallet request', () => {
    const event = { type: '@w3m-app/RPC_REQUEST', payload: {
      method: 'wallet_sendCalls', params: [{ chainId: '0x89', calls: [{ to: address, data: '0x' }] }],
    } };
    expect(W3mFrameSchema.appEvent.parse(event)).toEqual(event);
    expect(W3mFrameSchema.appEvent.safeParse({ ...event, payload: {
      ...event.payload, params: [{ calls: [{ to: 'invalid' }] }],
    } }).success).toBe(false);
    const response = { type: '@w3m-frame/GET_USER_SUCCESS', payload: { address, chainId: 137 } };
    expect(W3mFrameSchema.frameEvent.parse(response)).toEqual(response);
    expect(W3mFrameSchema.frameEvent.safeParse({ ...response, payload: { address } }).success).toBe(false);
  });

  it('preserves Coinbase discriminated policy rules and the legacy one-argument record API', () => {
    const rule = { operation: 'signEvmMessage', action: 'reject', criteria: [{ type: 'evmMessage', match: '^test$' }] };
    const policy = { scope: 'account', rules: [rule] };
    expect(CreatePolicyBodySchema.parse(policy)).toEqual(policy);
    expect(CreatePolicyBodySchema.safeParse({ ...policy, rules: [{ ...rule, action: 'invalid' }] }).success).toBe(false);
    const criterion = { type: 'evmTypedDataField',
      types: { primaryType: 'Mail', types: { Mail: [{ name: 'sender', type: 'address' }] } },
      conditions: [{ addresses: [address], operator: 'in', path: 'sender' }],
    };
    expect(SignEvmTypedDataFieldCriterionSchema.parse(criterion)).toEqual(criterion);
    expect(SignEvmTypedDataFieldCriterionSchema.safeParse({ ...criterion,
      types: { ...criterion.types, types: { Mail: [{ name: 'sender', type: 123 }] } },
    }).success).toBe(false);
  });

  it('rejects oversized policy collections before validating their elements', () => {
    // The vulnerable implementation traversed every element despite max(100).
    // A getter proves early rejection without allocating a dangerous payload.
    const rules = new Array(101);
    Object.defineProperty(rules, 0, { get() { throw new Error('oversized collection was traversed'); } });
    const result = CreatePolicyBodySchema.safeParse({ scope: 'account', rules });
    expect(result.success).toBe(false);
    expect(result.error.issues).toEqual([expect.objectContaining({ code: 'too_big', path: ['rules'] })]);
  });

  it.each(['viem', '@walletconnect/utils', '@coinbase/cdp-sdk'])('validates the ABI schemas resolved by %s', (consumer) => {
    const scopedRequire = createRequire(require.resolve(consumer));
    const { Abi, Address, TypedData } = scopedRequire('abitype/zod');
    const abi = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }],
    }];
    expect(Abi.parse(abi)).toEqual(abi);
    expect(Abi.safeParse([{ ...abi[0], inputs: [{ type: 'invalid' }] }]).success).toBe(false);
    expect(Address.safeParse('invalid').success).toBe(false);
    expect(TypedData.parse({ Mail: [{ name: 'sender', type: 'address' }] })).toEqual({ Mail: [{ name: 'sender', type: 'address' }] });
    expect(TypedData.safeParse({ address: [{ name: 'sender', type: 'address' }] }).success).toBe(false);
  });
});
