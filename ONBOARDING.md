# Repo onboarding guide

## What this repo is

`claude-skills` is a **Claude Code plugin marketplace** repo. The marketplace manifest is @.claude-plugin/marketplace.json, which lists two plugins:

| Plugin | What it does | Status |
|---|---|---|
| **cc-codex-review** | Claude × Codex 收敛互审 + 需求提取 + 协作执行 | main, active |
| **codex-image-gen** | Generate images via the `codex` CLI | stable |

`cc-codex-review` is where almost all the work happens; `codex-image-gen` is a single skill file (@codex-image-gen/skills/codex-image-gen/SKILL.md).

## cc-codex-review in one paragraph

It makes **Claude and Codex (two different AIs) review/collaborate adversarially** on the same piece of work — converging only when both AGREE, otherwise emitting a structured UNRESOLVED verdict for the human to decide. The point is to kill the blind spot of "a single AI says it's fine, so it's fine." Codex is invoked through `codex exec` and is **always read-only** — it can read files and run git, but never writes (a hard security invariant).

Three commands (see @cc-codex-review/commands):
- **`review`** — adversarial review of existing work (code / diff / doc / plan).
- **`extract-reqs`** — pull the user-endorsed requirements out of the conversation, so review has a trustworthy baseline.
- **`do`** — give it a task; Claude does the work, Codex collaborates read-only; complex tasks have both sides draft independent plans then converge.

## How it's built (important mental model)

Two layers:

1. **Deterministic scripts** in @cc-codex-review/scripts — `codex-round.mjs` (one Codex round), `review-state.mjs` (consensus ledger), `metrics.mjs`, `experiment.mjs`, `lens-parse.mjs`. These are pure-ish functions with **unit tests** in @cc-codex-review/tests.
2. **Prompt-level commands** — the `.md` files in @cc-codex-review/commands. The actual review/extract/do *behavior* lives in these prompts (executed by Claude), not in code. They have no unit tests; they're verified by running them + dogfooding.

Rule of thumb: deterministic logic goes in `scripts/` with a test; judgment/orchestration stays in the command `.md`.

## Dev workflow

- **Run tests:** `node --test cc-codex-review/tests/*.test.mjs` — use the glob (Node v22 rejects a bare directory). Should be all green.
- Edit `scripts/*.mjs` → run tests. Edit `commands/*.md` → that *is* the behavior change.
- **Dogfood before committing:** use cc-codex-review to review its own changes (the project does this routinely; it has caught real bugs in itself).
- Design decisions & roadmap live in @cc-codex-review/DESIGN.md — **§12 is the authoritative log** (P0–P4 decisions, known trade-offs). Read it first when picking up work. Per-feature specs/plans are under @cc-codex-review/docs.

## Deploy model (easy to trip on)

Editing the repo does **not** update the plugin you're running. The installed plugin is a frozen per-version copy in the cache. To make changes live:

```
claude plugin marketplace update fun-plugins
claude plugin update cc-codex-review@fun-plugins   # then RESTART Claude Code
```

Versions are bumped in @cc-codex-review/.claude-plugin/plugin.json; releases get a `cc-codex-review--vX.Y.Z` git tag (via `claude plugin tag`).
