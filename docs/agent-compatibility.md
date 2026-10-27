# Use Bunker with your agent

Bunker has one canonical skill at `skills/bunker`. It uses the open
[Agent Skills format](https://agentskills.io/specification): YAML metadata,
Markdown instructions, relative references and ordinary Node.js scripts.
Its MIT license is included in the folder. There is no model SDK, vendor API key,
MCP server or proprietary installer required by the skill. The agent host itself
may use a hosted model or a local/open-source model.

## Load the same folder

Start from a reviewed source revision. Install or copy the **complete** `bunker`
folder, preserving its name and relative paths. Inspect existing installations
before updating; do not overwrite customizations or install duplicate copies into
multiple discovery paths for the same host.

| Host | Where to place the folder | How to request it |
| --- | --- | --- |
| Codex | Its supported skill installer; documented project path `.agents/skills/bunker` or user path `~/.agents/skills/bunker` | `$bunker` or a natural-language request |
| Claude Code | Project `.claude/skills/bunker` or user `~/.claude/skills/bunker` | `/bunker` or a natural-language request |
| Another Agent Skills host | Its documented skill directory or installer | Its supported invocation syntax |
| Local/open-source agent without a skill loader | Any readable local directory, preserving the whole folder | Ask it to read the absolute path to `bunker/SKILL.md` and follow the workflow |

Paths and invocation syntax above follow the official
[Codex documentation](https://learn.chatgpt.com/docs/build-skills) and
[Claude Code documentation](https://code.claude.com/docs/en/skills).
Use the discovery mechanism supported by your installed host version. Existing
host-managed installations, such as those created by a bundled installer, do not
need moving just to match the table.

`agents/openai.yaml` is an optional display adapter for hosts that understand it.
It contains no execution logic, permissions or tool dependencies. The entire
`agents/` directory can be omitted; all setup/recovery instructions remain in
`SKILL.md` and `references/`. Do not maintain separate provider-specific workflows.

For an agent without native skill support, use a prompt such as:

> Read `/absolute/path/bunker/SKILL.md` and follow it to open Bunker locally.
> The application checkout is `/absolute/path/to/bunker-app`.
> Load linked references as needed. Ask me before applying the reviewed HTTPS
> changes; I will handle wallet and passkey approvals myself.

Supply actual local paths. No wallet credentials belong in that prompt.

## Capabilities, not model brands

| Capability | If the host lacks it |
| --- | --- |
| Read local files and run terminal commands | The user executes the exact commands locally and shares only non-secret results. The agent provides guidance, not a claim of execution. |
| Receive explicit approval | Use an ordinary conversation and wait for the answer before changing trust/domain configuration. Never infer approval. |
| Keep a foreground server running | Ask the user to keep a local terminal open for the server. Do not substitute an unmanaged daemon. |
| Open a browser | Give the user the local URL after the local checks pass. Browser automation is not required. |
| Access an interactive terminal for OS authorization | Hand the install/remove command to the user's terminal. Passwords never pass through chat. |

The execution machine must currently be **the user's Mac**. A cloud agent's
container or a remote Linux host cannot install trust into that Mac's Keychain,
and its loopback address does not reach the user's browser. Use a supported local
execution connection or a user-operated local terminal. Model/provider portability
does not add Windows/Linux hosting support to the current HTTPS installer.

## What is verified

`npm run test:skill` exercises copies in different host-directory layouts, including
copies with the optional adapter removed and vendor-specific environment variables
absent. The inspector is tested against fresh, interrupted, installed, expired and
invalid setup state. This verifies the portable files and helper behavior; it is
not an end-to-end evaluation of every model or host's decisions.

The user always performs wallet/passkey interactions. Current product limits do
not change with the agent: guided withdrawal remains demonstrative, guardian
recovery can submit real wallet-confirmed transactions, and publisher-authenticated
production releases are not available yet.
