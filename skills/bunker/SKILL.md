---
name: bunker
license: MIT
description: >-
  Prepare, verify and launch Picnic Bunker on the user's computer; resume or
  troubleshoot local setup and remove its HTTPS configuration when requested.
  Use when someone wants to set up Bunker or use it to recover a Picnic account.
  The Bunker UI runs the recovery flow; the assistant can answer questions on request.
---

# Bunker

Your primary job is to set up Bunker correctly, verify the local installation and
open its guided UI. Bunker guides account recovery; the user makes recovery choices
and approves wallet/passkey requests there. After launch, remain available for
questions and setup problems. Do not conduct or supervise a parallel recovery flow
in chat. Follow the user's language.

## Start with setup, then the UI

A request to recover a Picnic account using this repository is an account-recovery
request. Bunker is the tool, not the thing being restored. Do not ask the user to
choose between recovering their Picnic account and repairing Bunker software.
Repair setup problems encountered during launch; software development is a separate
task only when requested.

Proceed to source inspection and local setup. Before opening the UI, do not ask
whether the user has a passkey, wallet, email login, guardian, Safe address or
recovery destination. Those are decisions for the guided UI, not prerequisites
for launching it. Do not create an additional "other recovery method" option in chat.
Ask only for information that blocks local setup and cannot be inspected, or for
the concrete HTTPS authorization below. Keep existing safety and approval checks.

A suitable first response is: "I'll prepare Bunker on your computer and open the
recovery interface. You'll choose how to access your Picnic account there."
Once it is ready, open it and give the user the URL. Let the UI lead from there.

## Agent-independent execution

This is a portable Agent Skills folder: Markdown instructions, references and
dependency-free Node.js helpers. It requires no specific model, vendor API, MCP
server, plugin, subagent or named tool. Optional files under `agents/` affect host
presentation only; the workflow must work without them.

Map the operations below to the capabilities of the current host:

- Read files and run commands on the **user's Mac**, where the browser and Keychain
  live. A remote sandbox's `127.0.0.1` is not the user's computer. If local execution
  is unavailable, guide the user through commands in their local terminal and wait
  for results; do not install trust on a cloud host or expose a public tunnel.
- Request approval in ordinary conversation if no dedicated approval tool exists.
  Wait for the actual answer before OS mutations. Tool availability or invocation
  of this skill does not count as approval for an unreviewed certificate.
- Use a persistent terminal for the foreground server. If the host cannot retain
  processes, have the user run that command in a terminal they keep open. Do not
  claim the app is running after a tool has terminated its process.
- Browser automation is optional. Open the URL normally when supported, otherwise
  give it to the user. Wallet and authenticator prompts always belong to the user.
- If the host has no native skill loader, read this file directly and load linked
  references from this folder when needed. Do not assume `$bunker`, `/bunker`,
  vendor-specific path variables or a particular installation directory exist.

If a required capability is unavailable, state the specific handoff. A text-only
assistant can guide the process but must not claim to have performed local checks.

The current build is a **development preview**: account discovery, guardian
recovery and guided asset withdrawal are real. The user approves every signature
and transaction. State that before the user begins; support varies by asset and
deployment, and delayed routes require their on-chain waiting period. Do not call a simulation a transfer or a checksum an authenticated
release. Signed production releases are not yet available.

## Find the source and inspect

1. Locate the user's Bunker checkout. When this skill lives in the repository,
   its root is two directories above this file. An installed skill is only a copy
   of this directory; do not assume its parent contains the app.
2. If there is no checkout, obtain the source from `https://github.com/usePicnic/bunker`
   using the revision selected for this session. Read [source.md](references/source.md)
   for acquisition and trust boundaries. Do not silently choose another repo or
   upgrade a checkout already being used for recovery.
3. Run the bundled read-only inspector, resolving its path relative to **this skill**:

   ```sh
   node SKILL_DIRECTORY/scripts/inspect.mjs ABSOLUTE_CHECKOUT
   ```

   Record the full Git revision. Pass it as the optional second argument on later
   inspections to detect a revision change. The report identifies source changes,
   prerequisites, build files and existing HTTPS setup; it does not prove publisher
   authenticity, browser acceptance or wallet authority. Never upload the report.

Use macOS with Node 22.12+, npm, Git and OpenSSL for the current HTTPS flow. Explain
the specific missing prerequisite; use the user's existing package manager when
appropriate. Do not silently install a package manager, use root for the app, or
attempt the macOS trust commands on another platform. A phone can participate in
a wallet/passkey interaction supported by the provider; the local host remains a Mac.

## Prepare, approve, open

Run repository commands from the inspected checkout, keeping the revision fixed.
Read [local-session.md](references/local-session.md) for exact resume/cleanup cases.

1. **Build:** `npm ci --ignore-scripts`, `npm audit --audit-level=high`, then
   `npm run bunker:build`. Stop on a failed command. A passing audit is one check,
   not a security certification. Do not replace this with `npm run build`, which
   builds the separate workbench. Do not rebuild under an active recovery session.
2. **Prepare:** if setup is absent, run `npm run bunker:setup -- prepare`.
   This creates private TLS material and `.local-proof/setup-bunker/review.md`;
   it does not change certificate trust or `/etc/hosts`. Existing prepared/installed
   material must be inspected and reused or explicitly cleaned up, never overwritten.
3. **Authorize OS changes:** show the concrete review, exact CA fingerprint,
   seven-day expiry, `bunker.usepicnic.com → 127.0.0.1` mapping, login Keychain
   scope and reversal. Ask approval for those exact changes **before** running
   `npm run bunker:setup -- install APPROVED_FINGERPRINT`. This is the setup
   authorization, not a request to approve financial transactions. Reuse an existing
   explicit approval only for the same unchanged plan. The user enters any OS
   password privately in the interactive terminal; never request it in chat.
4. **Start:** run `npm run bunker:setup -- serve https://polygon-bor-rpc.publicnode.com`
   in a retained foreground terminal/session. This RPC is a default public endpoint,
   not an authenticity authority. Keep the process alive while the user works.
   If port 8443 is occupied, identify the listener and reuse the verified Bunker
   session or stop only a known previous session the user intends to replace.
5. **Check:** run `npm run bunker:setup -- doctor` from a second terminal. Resolve
   failed checks before handing over the URL. It checks local setup and pinned TLS;
   browser and real passkey acceptance remain separate.
6. **Open:** use the normal browser-opening capability for
   **https://bunker.usepicnic.com:8443/designs/guided.html?design=segments**.
   If browser access is blocked, give the user that link and hand off opening it.
   Verify browser acceptance separately from doctor. For Chrome certificate errors
   after successful local checks, follow the restart guidance in
   [local-session.md](references/local-session.md). Never bypass browser policy,
   HSTS, TLS validation or certificate warnings.

Tell the user when you are checking, building, waiting for OS authorization or
ready. On failure, name the failed stage and the next action. Do not print an
unexplained command list or claim the app is ready merely because the server started.
If an already running installation passes doctor and source/build provenance is
known, open it directly without rebuilding or asking for the same setup approval.

## Hand off, then answer questions if asked

The setup task is ready for handoff when the inspected build is running, local
checks pass and the guided URL has been opened or supplied to the user. This does
not establish browser/passkey acceptance or mean the account has been recovered.
Keep the handoff short: provide the URL, state the current development-preview
limit, and tell the user Bunker will guide recovery and you are available for questions.

The UI owns method selection, account discovery, access verification, guardian
recovery, destination, fees and withdrawal steps. Do not drive those choices in
chat, automate financial actions, or request progress updates after each screen.
The user completes every connection, passkey request, signature and transaction
confirmation. Never collect keys, seeds, passwords, OTPs or credential payloads,
and never approve on the user's behalf.

If the user asks about a recovery screen or reports an error, read
[recovery-questions.md](references/recovery-questions.md) and the relevant product
documentation. Answer the specific question, then let the user continue in the UI.
Keep local setup troubleshooting within this skill; do not restart or reroute a
financial operation to repair a display or connection problem.

## Finish or resume

Keep the server alive when handing the user the app; returning a chat message is
not the end of their session. Say how to ask the skill to resume or stop Bunker.
When the user wants cleanup, stop the retained server and run the exact fingerprint's
`remove` command from [local-session.md](references/local-session.md). Report remaining
configuration if cleanup fails; do not delete TLS state before successful removal.

Only when explicitly testing the extension or isolated read-only proof, use
[legacy-proof.md](references/legacy-proof.md). Those are development alternatives,
not the default Bunker experience.
