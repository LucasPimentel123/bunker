---
name: picnic-recovery
description: >-
  Guide Picnic passkey recovery experiments through the Chrome extension or the local macOS HTTPS proof: build a reviewed package, diagnose the Safe, validate an existing passkey, and simulate a withdrawal. The macOS fallback includes reversible HTTPS setup. Authenticated production releases and live passkey transfers are not yet available.
---

# Picnic local recovery proof

For the **passkey-only browser extension**, read `docs/passkey-extension.md`
first and use `extension:build`, `extension:test` and `extension:package`.
It runs from a packaged extension tab with fixed RPCs; it does not need the
local HTTPS setup described below. Do not install a CA or edit hosts for the
extension. Treat its unpacked development ID/checksum as context/integrity
information, not proof of publisher authenticity. Hand installation and real
passkey prompts to the user when browser policy prevents automation. No Magic
login, private-key import/storage or transaction broadcast is implemented.

Use the independent `usePicnic/bunker` repository. Locate the verified repository checkout and read its `docs/passkey-proof.md` before acting; it defines commands, acceptance criteria, credential-discovery limitations and exact cleanup. Resolve that path from the repository root, not from the installed skill directory.

## Run the right milestone

The first milestone is a real existing passkey plus full Safe withdrawal simulation while Picnic application services are unreachable. Synthetic test keys establish implementation correctness, **not** real credential compatibility. The experimental macOS setup now supports this test; do not claim a complete recovery installer or a validated real passkey until the experiment passes.

Inspect the checkout and Git revision first. A source checkout is not an integrity-verified release. Check Node/OpenSSL and build the separate `proof:build` target; use `proof:test` for the read-only proxy, setup and local Anvil integration tests. Do not republish the hosted recovery UI for this local experiment. Do not invoke the normal release archive as though it contained this proof. Do not download a floating branch and describe it as a verified release.

Use the CLI from the verified repository root:

1. `npm run proof:setup -- prepare` creates exclusive TLS material and `.local-proof/setup-v2/review.md` without changing trust or hosts. Existing prepared material is not overwritten; inspect it before retrying.
2. Present that concrete review and obtain authorization for the exact fingerprint and scope. It installs a **restricted local CA**, not the earlier hostname-scoped Keychain leaf entry. Its certificate permits only the recovery hostname, rejects its subdomains/IPs, expires in seven days, and its issuance key is not saved. The command omits macOS `-s` because Chromium ignores that policy. Previous approval of the old mechanism is not approval of this different mechanism. No general-purpose CA or TLS bypass flags.
3. After approval, run `npm run proof:setup -- install FULL_CA_SHA256_WITHOUT_COLONS` in an interactive terminal. The user completes OS authorization. Never request or enter their administrator password. Do not invent fingerprints, alter the review to avoid a failure, or retry a partially applied install blindly.
4. Run `npm run proof:setup -- serve INDEPENDENT_HTTPS_RPC` and retain the process/session handle for cleanup. It stays in the foreground and listens only on 127.0.0.1:8443. If another server owns the port, identify it; never kill an unknown process.
5. Run `npm run proof:setup -- doctor`. Distinguish certificate checks, native macOS trust, DNS and pinned local HTTPS from **browser acceptance**, which this command does not establish. Explain failures and keep pending work visible. On an interrupted install, inspect `state.json` and use `remove` for this exact installation before retrying; never delete its TLS files first.

Use the normal browser opening capability when available. Do not send the user to certificate settings as the routine installation flow. If browser automation is blocked, hand off opening the local URL; the skill is not an exemption from browser policy. Chrome compatibility and an existing passkey remain acceptance gates even when all local checks pass.

Use only public Safe/chain/credential metadata. Diagnose the current on-chain owners and signer before requesting a passkey. The user completes every authenticator interaction. If browser control is blocked by a security policy, let the user open the local URL; do not use another browser automation tool to bypass the block.

Guide **Validate passkey → Simulate withdrawal** in the local UI. Explain that the high nonce is overridden only within `eth_call`, that no transaction is sent, and that the external payer does not spend gas in this test. Never collect or paste wallet keys, seeds, authenticator secrets or vault exports. Never approve asset movements or biometric prompts for the user. Do not export assertion/signature payloads or log them to diagnose failures.

The proof UI uses device credential discovery; it has no metadata-upload section. For missing credentials, check the user's device/provider and explain the actual blocker. Non-discoverable credentials may require an ID that cannot be reconstructed from the on-chain public key; that fallback is not exposed in this UI. Do not direct the user to a nonexistent upload, manufacture a replacement passkey or bypass signature checks.

If the user needs guardian recovery instead, retain the existing independent guardian flow and its on-chain wait period. **Never use any recovery guardian as the replacement owner.** Do not upgrade Candide while the team is waiting for its upgrade greenlight. The proof app has no guardian mutation route.

Record evidence separately as: source revision, local tests, real user ceremony, full simulation, cleanup. Mark the real-credential milestone pending until both on-chain signature validation and the native withdrawal simulation pass. Keep reports to public metadata and user-approved sharing.

When finished, stop the server through the retained session and run `npm run proof:setup -- remove FULL_CA_SHA256_WITHOUT_COLONS`. The command refuses cleanup while port 8443 is in use, removes this CA's user trust/keychain entry and only its owned hosts line, and retains material if cleanup fails. Preexisting mappings and the old prototype's certificates are not owned by setup-v2. Remove those only through the separate documented legacy cleanup when authorized. Do not remove the user's passkey or unrelated certificates/domain entries. Report any incomplete cleanup explicitly.
