# Bunker recovery lifecycle tests

Run from the repository root, with Node and Foundry/Anvil installed:

```sh
npm ci --ignore-scripts
npm run check
npm run test:bunker:e2e
```

The command runs the guided controller regressions, access/passkey/wallet/recovery
unit tests, passkey contract integration tests, and the combined recovery lifecycle.
CI runs the same TypeScript suites through `npm test` and the controller suite
through `npm run test:guided`.

## The combined lifecycle

`tests/guided-recovery.integration.test.ts` creates a fresh random P256 credential
and a new Safe for each supported signer fixture (0.2.0 and 0.2.1). These signer
versions are **not** the guardian recovery module version. The recovery module
continues to use the repository's existing deployed-bytecode fixture; the test
neither upgrades it nor relaxes the guardian/new-owner exclusion.

The test:

1. Deploys the Safe, passkey signer, P256 verifier, recovery module and test ERC-20.
2. Enables recovery and configures the guardian using actual Safe transactions
   signed by the new passkey. Hashes are computed locally.
3. Validates the WebAuthn assertion on-chain and rejects an altered challenge and
   an unrelated passkey.
4. Runs the **shipped guided controller** through wallet selection, access checks,
   “Não tenho a passkey”, and new-owner entry. Asset scanning must remain blocked.
5. Rejects the guardian, Safe and zero address as the recovered owner, both in the
   UI and the transaction runtime. The new owner never needs to approve recovery.
6. Blocks recovery when the guardian has no gas (even when the Safe has funds);
   rejects a wallet signature, confirms no transaction was sent, then retries.
7. Approves and starts recovery through the UI's click handlers, production
   recovery adapter and transaction engine, checking loading and confirmed state.
8. Recreates the controller without its in-memory state, rediscovers the pending
   request, and rejects early finalization in both app permissions and the contract.
9. Advances **only Anvil's clock** past seven days and waits for the controller's
   automatic refresh to offer finalization.
10. Finalizes through the UI and checks the new owner, threshold, cleared recovery
    request and cleared pending-transaction journal.
11. Rejects the old passkey, reconnects the new owner and verifies that asset
    scanning is now allowed.
12. Transfers test ERC-20 and native funds through the recovered Safe, checks exact
    balances, and verifies the guardian still cannot act as owner.

All funds and transactions are local. The chain binds only to `127.0.0.1:18559`,
is not forked, and is destroyed afterward. The test refuses to attach to an
existing service on that port. The separate passkey contract suite uses port
18549. No Picnic/Magic backend, system certificate installation, real passkey or
customer wallet is needed. Dependency installation itself requires a network.

## What is real, and what is substituted

| Layer | Test behavior |
| --- | --- |
| Key and signature | Fresh software P256 key; authentic WebAuthn assertion format and cryptographic signature |
| Contracts | Actual Safe, passkey verifier/signer and recovery bytecode deployed locally |
| Recovery runtime | Production preparation, permissions, calldata, simulation, wallet submission, receipts and journal |
| Guided UI | Actual distributed JavaScript and its input/click handlers, executed with a minimal DOM adapter |
| Browser wallet | EIP-1193 adapter backed by unlocked local Anvil accounts; explicit signature-rejection scenario |
| Account index | Supplies the newly created Safe as a hint; authority is still verified on-chain |
| Inventory | Reads the local test token after the access gate; broad historical asset discovery is covered separately |

The tests do **not** render a browser, exercise `navigator.credentials.create/get`,
open biometric dialogs, or verify actual MetaMask/WalletConnect UI. Software test
credentials are not stored in the OS. Passing this suite is not a browser/device
compatibility guarantee or an independent security audit.

The guided withdrawal screen remains a demonstration. The final transfer in this
test proves control at the contract layer; it does not imply that the guided
withdrawal screen broadcasts transactions.

## Complementary regressions

The suite also checks wallet changes during asynchronous work, rejected and late
connections, partial network reads, gas queries returning zero/error, cancellation,
skipping/back navigation, passkey mismatch, a second assertion only for genuinely
ambiguous deployed candidates, pending receipts and duplicate-send protection,
new-owner exclusions across networks, and locally computed signing hashes.

Before a user-facing release, browser/device QA still needs to cover:

- A real existing passkey from each supported OS/password-manager combination.
- Guardian approval, wallet rejection, chain switching and reconnecting with the
  new owner, using disposable test accounts.
- Reloading during a pending transaction and resuming after the recovery delay.
- Portrait monitor, mobile keyboard, focus visibility, scrolling and touch targets.
- WalletConnect on a physical phone and injected wallets with conflicting providers.

Browser automation in the current environment was denied because its managed
security policy could not be verified. No alternate browser-control method was
used to bypass that restriction.
