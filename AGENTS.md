# Bunker agent entry

For a request to recover access to a Picnic account or open Bunker, read
[skills/bunker/SKILL.md](skills/bunker/SKILL.md) first and follow its setup workflow.
The account is being recovered; Bunker is the local tool used to do it.

The skill's primary responsibility is local setup, verification and launch.
After opening Bunker, let its UI guide recovery. Remain available for questions
and local setup problems; do not run a parallel recovery flow in chat.

Prepare and open the guided UI. Do not ask whether the user means account recovery
or software repair, and do not ask them to choose a passkey, wallet or guardian in
chat before opening it. The UI handles account access, discovery and recovery.
Ask only about actual setup blockers and the reviewed HTTPS authorization.

For a fresh setup without a specified revision, use the canonical repository's
current `main`, resolved to a full commit. Search results pointing at historical
feature branches do not override that choice. Preserve existing sessions and
the skill's source inspection, approval and signing boundaries.

For explicit development or software repair requests, follow the requested task
and [CONTRIBUTING.md](CONTRIBUTING.md); do not launch account recovery automatically.
