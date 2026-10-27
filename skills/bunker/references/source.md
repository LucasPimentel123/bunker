# Source and installation

The canonical repository is `https://github.com/usePicnic/bunker`. The skill lives
at `skills/bunker`. Select the intended Git revision and install the complete
folder with the host's skill installer, or copy it to the host's documented skill
directory. Keep `SKILL.md`, `references/`, `scripts/` and `LICENSE.txt` together.
`agents/openai.yaml` is optional presentation metadata; other hosts can ignore or
omit it. There is no dependency on an OpenAI/Anthropic installer or service.

For hosts without native skills, give the agent the absolute path to `SKILL.md`
and ask it to follow that file. References and helpers remain relative to that
file, regardless of the agent's working directory. Do not flatten the folder,
paste only its frontmatter, or assume a shell's current directory is the skill
directory. Do not overwrite an existing installation without inspecting it first.
The skill does not need wallet data to be installed.

Use an explicitly selected revision when one is supplied; otherwise resolve the
current `main` to a full commit before acquiring this development preview. Inspect
that revision rather than assuming the checkout contains the app. A future release
should name an exact tag/commit plus independently verifiable publisher signature.

For a new checkout, resolve the chosen ref in the canonical repository to a full
commit ID, clone into a new user-owned directory, and check out that exact ID in
detached mode. Verify `git rev-parse HEAD` matches before installing dependencies.
Use normal Git arguments, not a downloaded shell installer. Preserve any existing
working tree and setup state. Resolve GitHub unavailability as a source-acquisition
failure; do not substitute a similarly named repository or an unauthenticated mirror.

For a copied/installed skill, locate an existing checkout in the current workspace
or the location supplied by the user. Ask for its location only if it cannot be
found without searching unrelated personal directories. Paths in documentation
are relative to the checkout unless explicitly marked as skill-relative.

Inspect the revision, local diff and source origin before executing repository
scripts. A matching Git remote is a useful identity hint, **not cryptographic proof**:
it can be edited locally. A commit ID pins the selected source; it does not establish
who published it. A checksum or IPFS CID likewise proves content identity, not
publisher identity. No signed production Bunker release is available yet. Do not
invent a trusted signing key, signature or checksum, or present this source preview
as an authenticated recovery distribution.

Keep the selected revision fixed for a session. If local changes are intentional,
review them and describe the session as a modified development checkout. Never
discard changes to make a verification step pass. Stop on unexplained source
changes before running setup or a new recovery operation.
