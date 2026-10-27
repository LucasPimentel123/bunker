# Local passkey proof — milestone 1

For the normal guided Bunker experience, start with the
[Bunker skill](../skills/bunker/SKILL.md). It handles setup and opens
`/designs/guided.html?design=segments`. The root Bunker and isolated proof described
below are development entry points with different capabilities; they are not the
default guided flow. Guardian recovery in the guided flow is real; its withdrawal
screen remains demonstrative.

## Local Bunker profile

For the passkey-first discovery UI at **https://bunker.usepicnic.com:8443**, run:

```sh
npm run bunker:build
npm run bunker:setup -- prepare
# Review .local-proof/setup-bunker/review.md and obtain exact trust/hosts approval.
npm run bunker:setup -- install APPROVED_CA_SHA256
npm run bunker:setup -- serve https://polygon-bor-rpc.publicnode.com
npm run bunker:setup -- doctor
# Stop this server before removing this profile:
npm run bunker:setup -- remove APPROVED_CA_SHA256
```

This profile serves only on 127.0.0.1, uses a separate seven-day CA constrained
exclusively to bunker.usepicnic.com, and preserves the earlier recovery profile.
Both use port 8443, so stop the identified earlier proof server before starting
the Bunker. No public DNS or hosted Site is needed. The user must approve this
new certificate fingerprint and hostname mapping before installation.

The local Bunker has two entry points:

- **Passkey:** discover and validate the existing signer, select a verified Safe,
  then diagnose the recovery catalogue across ten networks. The inventory reuses
  the recovery app's native/ERC-20, card v5, investment and basket readers. Basket
  contents are shared across steps. Connect an injected external wallet for the
  payer address, choose a distinct destination and select networks. The planner
  builds batches locally and simulates each using a real passkey assertion and
  the reserved simulation nonce. **This route does not broadcast.** Each batch
  is simulated independently against chain state; earlier simulated batches do
  not change later state. Delayed card/investment steps remain explicitly pending.
- **External wallet:** use the existing recovery dashboard locally, including
  migration batches and guardian recovery when an on-chain module grants that
  wallet authority. This route can submit real transactions after the user's
  wallet confirmation. The guardian may never be a replacement owner or asset
  destination. No Candide module upgrade is included.

The passkey discovery ceremony normally asks for one assertion. A second is only
needed when distinct recovered public-key candidates both have verified deployed
Safes. Discovery currently checks Gnosis, Polygon and Ethereum; the subsequent
inventory checks the ten catalogue networks. Unsupported signers, thresholds and
unverifiable control remain blocked, not assumed supported.

The gas payer is read from the selected injected/EIP-6963 wallet, including account
changes, and checked again around the passkey ceremony and simulation. Connection
alone never signs, switches chain or sends a transaction. No WalletConnect relay
or remote wallet directory is included. Zero payer balance does not prevent the
passkey simulation; real migration requires funding. The extension/legacy proof
retains its manual payer field and native-currency simulation.

### Discovery without the Safe index

Address hints come from deterministic Picnic account derivation, the public Safe
index and, when the index is unavailable, partial or empty, on-chain `SafeSetup`
and `AddedOwner` events. The external-wallet route also checks the existing
canonical guardian/recovery events. **Every candidate must still pass deployed
Safe and current authority checks.** An index or historical owner event is not
proof of current control.

History is scanned backwards in bounded ranges, shrinking on provider errors or
result limits. Completed ranges are checkpointed in memory; retry continues from
the last unfinished range without another discovery assertion. The scan has a
fixed starting head, so it does not discover events created after that head in the
same session. Refresh starts a new scan and discards those checkpoints.

This is a fallback, not a complete replacement public index: old accounts may need
many retries, providers can refuse unfiltered logs or silently truncate responses,
and RPC availability is still required. Partial scans are never displayed as
proof that no other account exists. Local Ethereum/Polygon/Gnosis history reads
use endpoints that accept addressless event queries (Ethereum uses a separate
discovery endpoint without changing migration RPC defaults); the extension's
fixed providers can reject those queries and retain an explicit partial result.

### Network and signing boundaries

The local browser contacts only the exact independent RPC origins listed in
`scripts/proof/read-origins.json` and `api.safe.global`, plus its local origin.
CSP permits packaged scripts only, no frames, and inline styles for the existing
wallet UI. No Picnic backend is used. Custom RPCs outside that fixed allowlist
will be blocked by the local profile. This is application isolation, not an
OS-wide firewall; wallet extensions and passkey synchronization remain external.

Hashes and calldata are built locally. Each passkey batch is revalidated, checked
against forbidden guardian recipients, signed with a reserved nonce, verified by
the signer and executed through the full Safe `execTransaction` in `eth_call`.
Only the Safe nonce is overridden; balances, owners and code are not. Per-asset
route screening is an unsigned preflight, not a substitute for the final passkey
simulation. Simulated assets are never marked as migrated.

**Validation:** automated tests cover account-hint fallbacks, resumed history,
wrong-chain rejection, existing authority/guardian rules, and native + ERC-20
MultiSend simulations with generated P-256 credentials and real Safe/WebAuthn
contract bytecode on Anvil. The user has exercised existing-passkey discovery
and injected-wallet connection in the local Bunker. The expanded inventory/batch
UI still needs user acceptance with that passkey. No real funds were moved by the
automated tests. This remains a source build, not an authenticated release or a
production installer; a complete real install/remove cycle is still pending.

## Original proof profile

The sections below describe the earlier isolated, read-only proof at
`recovery.usepicnic.com`, not the external-wallet migration route above. It
verifies an existing Picnic passkey and simulates a native-currency withdrawal in
a deployed threshold-1 Safe. It never creates a credential, obtains a private
key, changes an owner or broadcasts a transaction.

## What this proves, and what it does not

1. Read a user-provided public Safe address on one explicitly chosen network. Validate the Safe deployment using the existing runtime registry; identify recognized WebAuthn v0.2.0/v0.2.1 owner proxies and extract their public key coordinates. Pin the singleton implementation code hash to the bytecode reproduced from the fixture factories; unknown implementations fail closed.
2. Request an existing credential for RP ID `usepicnic.com`. Without a credential ID, the browser can offer discoverable credentials. Picnic registrations used resident-key preference, not a guarantee: some old credentials require public metadata.
3. Check the exact challenge, HTTPS origin, RP ID hash, user presence and verification, strict DER encoding, and P-256 signature against the on-chain public key. Independently call the signer's ERC1271 `isValidSignature`.
4. Build the native withdrawal calldata and full Safe EIP-712 hash locally (chain ID, Safe address, every transaction field and simulation nonce), then sign only that locally derived hash, wrap the passkey signature in Safe's contract-signature format, and execute the full `execTransaction` via `eth_call`. The external payer is the caller; no payer signature or gas payment occurs during simulation.

Only the Safe nonce (storage slot 5, checked against `nonce()`) is overridden in the temporary RPC state. The selected nonce is `2^255 + random128`; the actual account nonce must be below `2^128`. The signature cannot execute at the current nonce. Owners, threshold, balances, guards, signer, verifier and destination code are **not** overridden. All simulation reads use one block. The same signed call is tested to fail without the nonce override. `getTransactionHash` is never called to obtain signing bytes: the contract is used only as an independent test oracle. A local invariant check runs before the passkey prompt and again before an assertion leaves the client; an inconsistent hash or a nonce outside the simulation range aborts. RPC responses still supply untrusted state/simulation results, so this change does not make the RPC or local software trustworthy by itself.

A successful result proves execution at that block under the documented nonce override. It does not guarantee future execution, estimate gas fees, prove every token transferable, or show that the external payer has enough gas. ERC20s, multisig thresholds, undeployed accounts, automatic cross-chain/account discovery and live broadcast are outside this first proof.

The browser is restricted by CSP to the local server. The server only proxies an allowlist of read RPC methods to the configured independent HTTPS endpoint; it rejects Picnic-named endpoints, redirects, cross-origin requests, batches and all send/sign/admin methods. No analytics, remote fonts, wallet relay, Picnic API, credentials or session are used. This blocks application traffic to Picnic; it is not an OS-wide firewall. Browser extensions and the operating system's passkey-sync provider are outside this isolation boundary. The proof is independent of Picnic services, not independent of an RPC or the user's passkey provider.

## Prerequisites and build

Use Node 22.12+ and an already trusted source checkout. For this development milestone, inspect the Git revision and changes. No signed/pinned proof release has been published yet; do not describe a source build or a checksum downloaded from the same unverified location as an authenticated release.

```sh
npm ci --ignore-scripts
npm run proof:build
npm run proof:test   # also needs Anvil; all writes in this test stay on its local chain
npm run proof:setup -- prepare
```

Setup uses OpenSSL and creates exclusive, seven-day machine-specific material under `.local-proof/setup-v2/`. The directory is mode 700; the private TLS server key is mode 600. It refuses to replace an existing setup. The TLS key is not a wallet key; do not share or commit it. `.local-proof/` and `proof-dist/` are ignored by Git and excluded from the normal release archive.

## Experimental guided setup (macOS)

The skill orchestrates these deterministic commands; no certificate-manager UI is part of the intended normal flow. The user still authorizes OS changes and completes every passkey ceremony.

1. `npm run proof:setup -- prepare` checks prerequisites/build/hosts conflicts, creates TLS material, saves a hosts backup and writes a concrete `review.md`. **No trust or hosts mutation.**
2. Review `.local-proof/setup-v2/review.md` with the user. It includes certificate fingerprints, expiry, keychain, exact changes and removal commands. Obtain specific authorization before installation.
3. `npm run proof:setup -- install FULL_CA_SHA256_WITHOUT_COLONS` applies the reviewed SSL trust in the current user's login keychain. Only a missing hosts mapping needs an administrative prompt. Existing loopback mappings are reused, never claimed or deleted. Conflicts and changed hosts snapshots stop the operation.
4. `npm run proof:setup -- serve https://polygon-bor-rpc.publicnode.com` starts the read-only proof in the foreground on 127.0.0.1:8443. Stop any identified previous proof server first; the installer does not kill arbitrary processes.
5. In another terminal, `npm run proof:setup -- doctor` checks certificates, native macOS trust, name resolution and the pinned HTTPS endpoint. Its JSON deliberately reports browser/passkey as **not-verified**. It uses an explicit CA only for the separate pinned transport check; native trust is tested independently. Neither proves Chrome acceptance.
6. Open the local URL normally and perform the acceptance experiment below. If browser policy blocks automation, the user opens it; do not bypass the policy through another automation surface.
7. Stop the server and run `npm run proof:setup -- remove FULL_CA_SHA256_WITHOUT_COLONS`. It removes only its CA and owned hosts line, preserving subsequent unrelated edits and preexisting mappings. A running listener, edited marker or failed cleanup prevents deletion of local material. The old `.local-proof/cert.pem` setup is independent; its cleanup is documented below.

### Certificate scope and why the mechanism changed

The earlier approach used a self-signed leaf with a hostname-specific Keychain policy. Chrome ignores that macOS policy (see below). The new proposal places restrictions **inside a unique local CA certificate**: critical `nameConstraints` permits `recovery.usepicnic.com`, excludes `.recovery.usepicnic.com` (all descendants) and all IPv4/IPv6 addresses; critical `pathlen:0` prevents subordinate CAs. It issues a single `CA:FALSE` server certificate with exactly the recovery DNS SAN and `serverAuth` EKU. The CA issuance key is kept in memory only and discarded after issuance; it is never saved or distributed. This does not protect against a compromised local installer or memory inspection while it runs.

The SSL trust command intentionally has no `-s`; hostname restriction is now enforced by certificate validation. This is a different trust object and **requires its own review and approval**, not silent reuse of the earlier approval. The proposed Keychain scope is the current user, not the entire system. Automated tests exercise allowed and rejected certificate chains using OpenSSL and native macOS validation with an explicit test root; tests do not install trust. These tests do not establish identical behavior in every app, nor replace Chrome and real installation acceptance testing. Source: [Chromium anchor constraints and macOS policies](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc), [RFC 5280 name constraints](https://www.rfc-editor.org/rfc/rfc5280#section-4.2.1.10).

Setup journals intent before trust/hosts mutations and serializes install/remove operations. If interrupted, diagnose and remove that installation before retrying. An operation lock left after a crash requires inspection of the recorded PID/state before removing the lock. Certificate and hosts backups remain until cleanup succeeds. An expired certificate must still be uninstalled; expiry does not undo OS configuration.

## Legacy prototype setup (reference and cleanup only)

`https://localhost` cannot use a passkey registered for `usepicnic.com`. This proof uses `https://recovery.usepicnic.com:8443`, resolved to loopback, so it is a valid RP-ID suffix and a trusted HTTPS origin.

**Before changing trust or `/etc/hosts`, show the user the exact certificate path, SHA-256 fingerprint, validity, hostname, keychain, hosts entry and reversal. Obtain their explicit authorization.** This is a user requirement, not permission to install a general-purpose certificate authority or modify other domains. Never disable browser TLS/WebAuthn protections or install browser ignore-certificate flags.

### Browser compatibility of hostname-scoped trust

Chromium's macOS trust-store implementation skips trust entries containing `kSecTrustSettingsPolicyString`. Consequently, the exact hostname-scoped trust configured below can pass native macOS verification while Chrome reports `NET::ERR_CERT_AUTHORITY_INVALID`. Repeatedly reinstalling the same entry or bypassing the warning does not solve this compatibility issue. Source: [Chromium trust_store_mac.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc#112).

For this legacy restricted setup, Safari remains an unverified browser alternative. Native `security verify-cert` / SecureTransport success is **not** a completed browser acceptance test; the user must still open the page and confirm that the browser accepts HTTPS before invoking the passkey. Existing credential availability may differ by browser/provider. The setup-v2 proposal above is the new path under test for Chrome.

Do not silently remove the hostname restriction or install a broader CA to make Chrome work. A different Chrome-compatible trust design requires a concrete review of its scope and user authorization before changing the approved trust configuration.

Inspect `.local-proof/plan.json` and the certificate:

```sh
openssl x509 -in .local-proof/cert.pem -noout -subject -dates -fingerprint -sha256
```

After authorization, the proposed trust operation is scoped to the current user's login keychain, SSL policy and this hostname. Substitute the actual absolute certificate path and current user's login keychain:

```sh
security add-trusted-cert -r trustRoot -p ssl -s recovery.usepicnic.com \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  /ABSOLUTE/PATH/.local-proof/cert.pem
```

Inspect `/etc/hosts` for an existing mapping first. If one exists, stop and review it; never overwrite it. Save a backup and append exactly one marked line (requires an OS administrator prompt):

```text
127.0.0.1 recovery.usepicnic.com # picnic-recovery-proof-UNIQUE-CERT-ID
```

Record the original mapping, the exact marker and the approved change in local state. Do not include other Picnic domains. The server binds **only `127.0.0.1:8443`**, not all interfaces.

## Run the acceptance experiment

```sh
npm run proof:setup -- serve https://polygon-bor-rpc.publicnode.com
```

Open `https://recovery.usepicnic.com:8443` without bypassing certificate errors. For another network, stop the server and use its independent HTTPS RPC; enter that network's chain ID. RPC URLs containing credentials are not supported by this proof.

1. Enter the public address of the Safe and the network's chain ID. The original connected EOA/guardian address is not necessarily the Safe. Do not infer ownership from an address hint alone.
2. Select the detected signer and click **Validar passkey**. The user chooses their existing passkey and completes biometric/PIN verification themselves. This first random challenge is not a withdrawal authorization.
3. If the credential is not offered, check the device/provider where it was saved. The UI uses credential discovery and has no JSON metadata upload. Non-discoverable credentials may require an ID that is not generally reconstructible from the contract's public key; this remains a compatibility limitation. Never ask for a seed, private key, full credential vault or an account export containing secrets.
4. Enter a distinct recipient, external EOA payer and a small **native-currency** amount available in the Safe. Click **Validar passkey e simular**. The user completes the second passkey ceremony. The server has no broadcast route.
5. Record the result shown: chain, block, Safe, signer, payer, recipient, amount, nonce-only override, and `broadcast: false`. Do not record authentication assertions, signatures, TLS private key, or anything from the user's authenticator UI. The report is public metadata, so share only with the user's intent.
6. In browser Network tools, verify all app requests target the local origin; the backend accesses only the selected RPC. Record browser/OS and the outcome of credential discovery. Mark the premise validated **only after the real existing credential and the full simulation both succeed**.

The on-chain signer validates challenge/cryptography/verification flags; the local client additionally enforces origin and RP ID. A valid parent RP ID does not prove every authenticator/provider will permit this existing credential at the new subdomain. Only the actual user ceremony establishes compatibility.

## Failures

- **Certificate error / wrong origin:** verify the approved exact certificate, mapping, hostname and validity. Do not click through or disable validation.
- **Passkey absent or NotAllowedError:** may be cancellation, expired prompt, unavailable device/provider, or a non-discoverable credential. Retry once with the user's intent and check their device/provider. The UI does not support importing credential metadata. Do not create a replacement passkey and call that a successful test.
- **Wrong signer:** choose the correct detected on-chain owner. A different passkey must fail locally and on-chain.
- **RPC state override unsupported:** choose another independent RPC for the same chain. Do not replace the test with an unprotected current-nonce transaction signature.
- **Revert:** report the failed simulation. Do not bypass guards, supply fabricated balances, remove the signer check or automatically send a different transaction.
- **No passkey access:** the separate guardian recovery flow may be used only if its authority is already configured. **A guardian must never be the replacement owner**, including the connected guardian. Keep existing UI/core pre-sign and pre-broadcast checks; do not upgrade the Candide module without the team's greenlight. This experimental app does not start guardian recovery.

## Remove the legacy local setup

1. Stop the proof server with Ctrl+C and verify port 8443 is closed.
2. Remove trust for this certificate in the same user store, then delete precisely this fingerprint from the login keychain. Keep the cert file until this succeeds:

   ```sh
   security remove-trusted-cert /ABSOLUTE/PATH/.local-proof/cert.pem
   security delete-certificate -Z EXACT_CERTIFICATE_SHA256_WITHOUT_COLONS \
     "$HOME/Library/Keychains/login.keychain-db"
   ```

3. Remove only the exact marked hosts line added for this experiment. Preserve any subsequent unrelated changes; do not restore the entire backup blindly. Verify the original resolution is restored.
4. Remove the local `.local-proof/` directory only after trust/domain cleanup succeeds. Never delete other certificates or authenticator credentials. Keep the source and evidence if desired.

## After the acceptance gate

Only after the new setup passes real browser/installation/removal tests and a real existing passkey succeeds: package a fixed reproducible release, establish an authenticated integrity channel, expand discovery/metadata compatibility, integrate live direct signing plus the user's external gas payer, and validate setup across supported systems. Preserve the existing guardian fallback and absolute guardian/new-owner prohibition. The skill tracks these states; it must not present this proof as the complete installer.

## Primary references

- [WebAuthn RP ID and origin rules](https://www.w3.org/TR/webauthn-2/)
- [Safe passkey architecture](https://docs.safe.global/advanced/passkeys/passkeys-safe)
- [Safe WebAuthn contracts, pinned source](https://github.com/safe-global/safe-modules/tree/b6bd0d0ad45b213fe24534cc079d4a0731de2ed8/modules/passkey/contracts)
- [Safe 1.4.1 transaction/signature validation](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/Safe.sol)
