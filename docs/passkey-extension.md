# Picnic Bunker — passkey extension (experimental)

This is a Chrome desktop Manifest V3 extension for the passkey proof. It opens
in a full tab and reuses the verified Safe/WebAuthn signer inspection, local
signature verification and native withdrawal simulation. It does not use the
local proof server, /etc/hosts, a local CA, Magic or Picnic application services.

**Scope:** Polygon, Gnosis and Ethereum; deployed supported Safes with threshold
1 and recognized passkey signers. The user chooses an existing discoverable
passkey; no Safe address or Picnic database is required. One assertion starts discovery of the candidate public keys. A second assertion
is requested only when distinct candidates have verified deployed Safes.
This version validates access and simulates a native withdrawal. It does not
broadcast, migrate ERC20s/baskets, import wallet keys, create passkeys, store a
credential vault, or implement guardian recovery. Signing credentials remain in
the user's authenticator/provider. Closing the tab clears the app's in-memory
progress and credential selection; no storage permission is requested.

## Build and load

From an already trusted source checkout, with dependencies installed:

```sh
npm run extension:build
npm run extension:test
npm run extension:package
```

For this developer build:

1. Open `chrome://extensions` yourself and enable Developer mode.
2. Choose **Load unpacked / Carregar sem compactação**.
3. Select the repository's `extension-dist` directory (the directory containing
   `manifest.json`). For an archive, extract it and select that directory.
4. Open **Picnic Bunker — Passkeys** from Chrome's extensions menu. It opens a
   regular tab; a toolbar popup is deliberately avoided during passkey prompts.
5. Click **Continuar com passkey**, choose the existing credential and
   complete the device ceremony personally. Discovery starts automatically.
   This is a random local discovery challenge, not a transaction hash.
6. The extension checks Polygon, Gnosis and Ethereum automatically. It derives
   the pinned v0.2.0/v0.2.1 signer addresses locally (including the v0.2.1 packed
   verifier), checks deployed bytecode and requests Safe address hints from
   Safe's public transaction service. Every accepted account is checked on-chain
   for current ownership, supported Safe/signer code and ERC1271 signature
   validity. Choose a verified account to simulate; selection rechecks authority.
7. Optionally fill a native amount, recipient and simulated external payer,
   then choose **Validar passkey e simular**. This is a separate user ceremony.
   No real gas is paid. Only the nonce is overridden within `eth_call`; the
   signed high nonce cannot execute at the current account nonce.

An unpacked extension is a developer installation, not a signed production
release. Its fixed development ID is `pgpkjpapfnlckahlfodaomcegjbaoabn`. The
manifest's public key stabilizes that ID across machines; **anyone can copy a
public manifest key**, so the ID alone does not prove authorship. The ZIP checksum
and BUILD.json detect changes against a separately trusted reference; they are
not an independent authenticity channel. No Chrome Web Store release exists yet.

## Permissions and trust boundaries

- `https://usepicnic.com/*` is needed for Chrome to allow the extension to request
  an existing credential for RP ID `usepicnic.com`. It is a sensitive host
  permission. The extension declares no content scripts, scripting permission,
  external message handlers, web-accessible resources or website integration.
- Three public RPC hosts and `https://api.safe.global` have network permissions. The extension's CSP
  excludes Picnic from `connect-src` and permits only packaged scripts/styles.
  The permission for the RP ID does not cause a request to the Picnic website.
- RPC requests use an explicit read-method allowlist, HTTPS, no cookies, no
  referrer, no redirects, bounded responses and a timeout. Sign/send/admin
  methods are rejected before network access. CCIP reads are disabled.
  Transient "header not found" / "unknown block" responses are retried twice
  with the exact same request and pinned block; other errors remain visible.
- All signing bytes and Safe hashes are constructed locally. The extension
  origin is pinned in the build and verified in clientDataJSON. Assertions must
  bind the correct RP ID, challenge, user presence/verification and on-chain key.
- Assertions are sent to the selected RPC for on-chain verification/simulation;
  they are not logged, persisted or sent to Picnic. Public queries reveal account
  addresses to that RPC. The Safe index receives only derived public signer
  addresses, not credential IDs, assertions, e-mails or user handles. Index
  responses are bounded and paginated at a fixed host; returned URLs are never
  followed. A compromised build or browser remains a threat.
- Passkey sync/device providers can still be needed. Non-discoverable credentials
  without their identifier may not be offered; there is no metadata upload UI.

## Discovery model and limits

A WebAuthn assertion does not return the credential public key. ECDSA public-key
recovery yields multiple candidates from one signature. Each candidate is verified
locally with WebCrypto; its pinned signer addresses are calculated locally and
checked for deployed code. Index hints only count after verifying supported Safe
code, current signer ownership and ERC1271 validity on-chain. One candidate with
verified Safes enables account selection; multiple Safes/networks for the same
key do not require another assertion. Only multiple distinct candidates with
verified Safes enable the second prompt and block selection until resolved.
That fallback pins the same credential ID, uses a different local challenge and
intersects the keys, verifying both signatures locally. When no accounts are found or queries fail, users can retry using the original
assertion; neither condition triggers a second prompt.

The single-assertion path depends on truthful RPC state for account association;
it does not uniquely identify the credential key from cryptography alone. Index
omissions or RPC failures can leave other candidates unresolved and remain
visible. Account selection revalidates ownership, and the separate simulation
assertion must verify locally against the selected on-chain public key before
being sent to a provider. A forged association therefore cannot substitute
signing bytes or bypass local signature verification. userHandle is never used
as authority. No private key is extracted or reconstructed.

The Safe index is an **availability dependency for discovery**, not a Picnic
service and not evidence of account authority. It can omit accounts or lag.
This version does not include a full-chain ownership-event index or portable
index snapshot. Missing results do not establish that the user has no accounts.
RPC/index failures remain visible per network and can be retried without new
passkey prompts while the tab remains open. Existing non-discoverable credentials
without their credential ID cannot be found by this flow. Other networks,
undeployed/counterfactual accounts and threshold >1 are outside this proof.

## Acceptance status and limitations

Automated tests use generated test passkeys and actual Safe/WebAuthn contract
bytecode in Anvil, including public-key identification, address discovery and
rejection of unrelated accounts or altered signer code. They are not evidence that a real user's existing credential
is available through an extension. **Real Chrome installation, real passkey
selection, on-chain validation and full simulation must be completed by the user.**
Browser automation policy must still be respected; do not use alternate browser
control methods to bypass a blocked extension-management page or authenticator.

For the acceptance test, use the extension without the local HTTPS server and
confirm that no app traffic reaches Picnic or localhost. Validate the existing
passkey and complete the simulation. Record browser/provider and public results,
never the assertion, private keys or authenticator UI contents. Verify cancellation,
wrong passkey and unsupported signer paths fail clearly. Uninstall from Chrome's
extensions page when finished. This does not remove the user's passkey or the
separate legacy local-HTTPS setup.

## Sources

- [Chromium RP-ID permission checks](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webauthn/chrome_web_authentication_delegate.cc)
- [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Development extension IDs](https://developer.chrome.com/docs/extensions/reference/manifest/key)

- [Safe owner lookup API](https://docs.safe.global/core-api/transaction-service-reference/mainnet)
- [Noble curves public-key recovery](https://github.com/paulmillr/noble-curves)
