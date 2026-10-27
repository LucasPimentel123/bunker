# Contributing to Bunker

Use Node.js 22.12+ and install dependencies from the lockfile:

```sh
npm ci --ignore-scripts
```

Create a branch for changes. Keep PRs focused, explain the behavior change and
include the checks you ran. Start with the [architecture](docs/architecture.md)
and the [coverage document](docs/coverage.md).

## Checks

```sh
npm run check
npm run test:bunker:e2e
npm test
npm run build
npm run bunker:build
npm audit --audit-level=high
```

The `zod` override pins 4.6.7 to fix
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
Some wallet SDKs still request Zod 3. `tests/wallet-sdk-schemas.test.ts` exercises
their installed Reown, Coinbase and ABI schemas with valid and invalid payloads,
including early rejection of oversized policy collections. Keep this coverage
when upgrading those SDKs; remove the override when their declared ranges support
a patched release. Do not bypass the audit gate to accommodate a dependency.

Contract tests need Foundry/Anvil. Use disposable test keys and local chains;
never use a customer's account to validate a write path. Fork tests are optional
(`npm run test:fork`) and execute all writes locally.

Keep these invariants intact:

- Compute signing hashes locally. RPC responses are untrusted inputs.
- Recheck the active wallet, chain, permissions and transaction before sending.
- Never allow a recovery guardian as the replacement owner.
- Keep partial or failed reads distinct from zero balances.
- Preserve pending transaction receipts; a timeout does not mean nothing was sent.
- Request every wallet/passkey approval from the user. Do not auto-approve.
- Keep demonstration screens explicit about not moving funds.

## Privacy before pushing

Use synthetic addresses in tests. Do not commit personal wallet/Safe addresses,
credential exports, screenshots of customer accounts, private keys or RPC tokens.
Local TLS files and setup state belong in the ignored `.local-proof/` directory.
Do not force-add ignored files or package them into releases.

Git author and committer metadata is public. Use the noreply address provided by
your GitHub account if you do not want to publish your personal email. Removing
information from the latest files does not remove it from earlier commits.

For security-sensitive findings, use the repository's private vulnerability
reporting feature if it is enabled. Do not post secrets or customer information
in public issues.
