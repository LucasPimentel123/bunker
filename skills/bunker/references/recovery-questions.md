# Optional support after launch

Read this only when the user asks a question about recovery or reports an error
in the Bunker UI. These are support boundaries, not a chat questionnaire or a
second recovery procedure. Explain the relevant screen or error and let the user
continue in the UI. Ask for additional context only when needed to answer.

- **Access:** the UI offers passkey or external wallet and verifies current
  authority before asset discovery. Let its automatic discovery run; do not ask
  for a Safe address unless a specific discovery problem requires it. Lack of a
  usable passkey or configured guardian can be an actual recovery limitation.
- **Fees:** a passkey user also needs an external wallet to pay transaction fees.
  The UI checks network balances and offers funding or skipping a network.
  Explain those choices when asked; do not move funds for the user.
- **Guardian recovery:** the UI can perform configured guardian recovery and
  displays the on-chain delay. No guardian may become the new owner. Do not
  upgrade the Candide module as part of setup or recovery.
- **Withdrawal:** guided asset withdrawal is currently demonstrative, although
  guardian recovery can submit real wallet-confirmed transactions. If the user
  explicitly requests a real exit, consult `docs/recovery-app.md` in the checkout
  and explain the separate workbench's supported route and limitations. Do not
  silently switch the user into another execution flow.
- **Errors:** RPC/index failures do not imply zero balances. Preserve progress
  and explain the app's relevant retry action. An absent transaction result is
  not evidence of failure: establish its on-chain status before suggesting a
  retry. Never restart a pending financial operation to fix a missing UI result.

Do not request private keys, seeds, passwords, OTPs, passkey assertions or
credential-vault exports. The user performs all wallet and authenticator actions.

### Security key opens a phone QR code

The user can select **Com uma chave de segurança** to prefer a YubiKey or other
physical authenticator. This sends WebAuthn's `security-key` hint, not a transport
restriction. Browsers that ignore hints retain their normal chooser. If a phone QR
code still appears, use the browser's other-device/options control to choose a
security key. The user handles insertion, PIN and touch privately. Do not conclude
that the key is empty from a canceled or timed-out request.

Discovery still requires a discoverable credential for `usepicnic.com`. An older
non-discoverable credential needs its credential ID; this UI does not add an import
flow or reconstruct it from an on-chain public key. Never reset the key or create a
replacement credential as a troubleshooting step. HTTPS acceptance, opening the
security-key chooser, and successful on-chain verification are separate outcomes.

References: [Chrome WebAuthn hints](https://developer.chrome.com/blog/passkeys-updates-chrome-129),
[Yubico credential discovery](https://developers.yubico.com/Passkeys/Passkey_concepts/Discoverable_vs_non-discoverable_credentials.html).
