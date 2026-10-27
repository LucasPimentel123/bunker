# Local session lifecycle

Commands below run from the inspected Bunker checkout. The canonical profile is
`bunker`, the setup directory is `.local-proof/setup-bunker`, and the guided URL is
`https://bunker.usepicnic.com:8443/designs/guided.html?design=segments`.
The inspector lives in the installed skill, so pass the checkout path explicitly.

| Inspector state | Next action |
| --- | --- |
| `absent` | Install locked dependencies, audit, build, then `bunker:setup -- prepare`. |
| `prepared` | Read the existing review; present exact changes and obtain/reuse approval for this plan. |
| `installed` | Verify build/revision and run doctor against the known server, or start it then run doctor. |
| `interrupted` | Inspect the operation journal/lock, diagnose and clean up this installation before retrying. |
| `expired` | Stop the known server, remove this exact installation, then prepare a new certificate and seek approval for its new fingerprint. |
| `invalid` | Stop setup automation; inspect the specific inconsistency without overwriting files. |

Build presence alone does not establish build provenance. When it is unknown,
build the reviewed source before starting a new server. If a known live session
is in use, do not replace its bundle underneath it; arrange a clean restart first.

## Authorization and interrupted installation

`prepare` must complete before requesting OS-change approval. Read the actual
`review.md`; it contains paths, fingerprints, expiry, exact trust/hosts changes
and reversal. The CA is unique to this machine, name-constrained to the Bunker
hostname, and valid seven days. Its issuance key is not persisted. The server key
and installation journal are private local material, not items to commit or share.

Use an interactive terminal for `install` and `remove`. The user supplies OS
credentials privately. A previous approval for `recovery.usepicnic.com` or an old
fingerprint does not authorize this new certificate. Do not use broad trust, browser
ignore-certificate flags, root execution of the app, or a public tunnel.

If interrupted, inspect `state.json` and `.operation.lock`. Do not delete a lock
until its recorded process is confirmed stopped and the journal has been reviewed.
The installer journals intent before mutation; `installed: false` does not prove
that no trust or hosts change occurred. Normally remove this exact installation
before preparing again. For a known trust-success/hosts-only interruption,
`npm run bunker:setup -- resume-hosts APPROVED_FINGERPRINT` is available only after
reviewing the unchanged approval and journal; it revalidates trust and hosts state.

## Starting and diagnosing

```sh
npm run bunker:setup -- serve https://polygon-bor-rpc.publicnode.com
# In another terminal:
npm run bunker:setup -- doctor
```

Retain the terminal/process handle. Do not detach a server whose lifecycle you
cannot manage. Only reuse another listener after confirming it is the intended
Bunker checkout and the pinned certificate/config checks pass. A successful doctor
does not certify the browser, authenticator, app bundle or publisher.

The server's `/config` reports a read-only RPC proxy. This does **not** mean the
whole guided app is read-only: guardian recovery uses the connected wallet and
can submit real transactions. Do not tell the user that setup implies simulation-only
behavior. Guided withdrawals also submit real transactions approved by the user.

For a missing prerequisite, explain what is missing; do not retry unchanged commands.
For an RPC failure, retry the read or use another supported independent HTTPS RPC.
For a browser certificate failure, inspect expiry, trust, hostname and the known
listener; never click through. If the browser automation policy denies access,
hand the local URL to the user rather than changing automation surfaces.

### Chrome still shows NET::ERR_CERT_AUTHORITY_INVALID

If every doctor check passes after installing the approved CA, Chrome may still
need a full restart to pick up local trust. Ask the user to save browser work and
restart Chrome with `chrome://restart`, then reopen the guided URL in the profile
that holds their wallet. Do not restart during a wallet/passkey request or pending
transaction. Do not reinstall the CA, broaden trust or bypass the warning.
Verify that the actual browser loads the guided page without a TLS interstitial;
doctor alone cannot establish this. If the warning persists, inspect the browser's
certificate, profile and policies instead of assuming a cache issue.

Chrome consumes local SSL trust from the macOS Keychain; see the
[Chrome trust-store FAQ](https://chromium.googlesource.com/chromium/src/+/main/net/data/ssl/chrome_root_store/faq.md).
Other browsers and authenticator providers still require their own acceptance checks.

## Cleanup

When requested, stop the retained foreground session (Ctrl+C), confirm its port is
closed, then use the installation's actual fingerprint:

```sh
npm run bunker:setup -- remove APPROVED_FINGERPRINT
```

Removal deletes only its own CA trust/certificate and marked hosts line. Preexisting
domain mappings remain. It refuses to proceed while port 8443 has a listener and
retains TLS material if cleanup fails. Expiry alone does not undo system changes.
Do not remove passkeys, unrelated certificates, other profiles, or restore the entire
hosts backup over later edits. Keep a failed cleanup visible and resumable.

For the earlier recovery profile or hostname-scoped leaf experiment, consult
`docs/passkey-proof.md` in the checkout; those objects are not owned by this profile.
