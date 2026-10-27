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
- **Withdrawal:** the guided UI prepares real withdrawals, simulates them and asks
  the user to authorize with their passkey/owner wallet and confirm submission
  with the gas-paying wallet. The payer may also receive funds. Card queueing is
  not receipt of funds: wait for the contract delay, then explicitly release it.
  Unsupported or blocked routes stay visible; do not describe them as completed.
- **Errors:** RPC/index failures do not imply zero balances. Preserve progress
  and explain the app's relevant retry action. An absent transaction result is
  not evidence of failure: establish its on-chain status before suggesting a
  retry. Never restart a pending financial operation to fix a missing UI result.

Do not request private keys, seeds, passwords, OTPs, passkey assertions or
credential-vault exports. The user performs all wallet and authenticator actions.
