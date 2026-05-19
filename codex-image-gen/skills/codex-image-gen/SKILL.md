---
name: codex-image-gen
description: Generate images by shelling out to the external `codex` CLI. Use this skill whenever the user asks to create, generate, draw, render, or produce an image / picture / illustration / artwork — even if they don't mention "codex" by name, and even if they don't specify a save path. Triggers on Chinese phrases like 生成图片、画一张、生图、出一张图、做一张图、渲染一张、来张图 and English equivalents like "generate an image", "draw a picture of", "make me a picture of", "render an image", "create an image of". Always prefer this skill over describing the image in text — the user wants an actual image file on disk.
---

# Codex Image Generation

This skill wraps the external `codex` CLI so Claude can generate images on the user's machine and save them to a specified path. Claude does NOT generate the image itself — it constructs the right `codex exec` command and runs it via Bash.

## When to use

Trigger this skill whenever the user wants an image. Typical phrasings:

- "帮我生成一张鹰在天空飞翔的图"
- "画一张赛博朋克城市的图片"
- "生图：一只猫坐在窗台上"
- "Generate an image of a sunset"
- "来张科幻飞船的图"

The user does NOT need to specify a save path or mention codex for this skill to trigger. If they don't give a path, default to saving in the current working directory with a sensible filename derived from the description.

If the user only wants a description, a prompt, or ideas about an image — do NOT use this skill. This skill is only for actually producing an image file.

## Prerequisites

Before the first invocation in a session, verify `codex` is installed:

```bash
which codex
```

If it returns nothing, tell the user to install codex from https://github.com/openai/codex and stop. Don't try to fall back to other tools.

## Fixed command contract

These flags are **always** used, never omitted, never substituted:

- `-a never` — never ask for approval (non-interactive)
- `exec` — one-shot execution mode
- `-s danger-full-access` — full sandbox bypass (required so codex can write files anywhere)
- `--skip-git-repo-check` — don't refuse to run outside a git repo

The only flag that varies is `--cd <DIR>` (see "Working directory rules" below).

Template:

```bash
codex -a never exec -s danger-full-access [--cd <WORKDIR>] --skip-git-repo-check "<PROMPT>"
```

Do not add any other flags the user didn't explicitly request. Do not change `-s danger-full-access` to a safer mode even if the destination looks sensitive — the user has accepted this contract.

## Working directory rules

Decide whether to pass `--cd` based on how the user phrased the save path:

1. **No path mentioned, or only a bare filename** (e.g. "命名为 test.png", or no filename at all)
   → omit `--cd`. The image lands in Claude's current working directory. If no filename was given, pick a short descriptive one like `eagle.png` and tell the user.
   Example: `codex -a never exec -s danger-full-access --skip-git-repo-check "生成一只鹰在天空飞翔的画面，命名为 test.png"`

2. **Relative path under a specific project directory** (e.g. user says "保存到当前目录 ./test/image.png" while referring to a named project)
   → use `--cd <that project dir>` and keep the relative path in the prompt.
   Example: `codex -a never exec -s danger-full-access --cd /Users/fun/SII/Research/game_generate --skip-git-repo-check "生成鹰在飞翔的画面，保存到 ./test/image.png"`

3. **Absolute path** (e.g. "/Users/fun/.../image.png")
   → pass `--cd <parent project dir>` AND keep the absolute path in the prompt. Codex needs a working directory anchor; the absolute path inside the prompt tells it exactly where to write.
   Example: `codex -a never exec -s danger-full-access --cd /Users/fun/SII/Research/game_generate --skip-git-repo-check "生成鹰在飞翔的画面，存储为 /Users/fun/SII/Research/game_generate/test/image.png"`

When in doubt, prefer being explicit about the save path inside the prompt string — codex follows the prompt's instructions literally.

## Prompt construction

Pass the user's image description through to codex roughly as-is, but make sure the prompt explicitly says **where to save the file**:

- If the user gave a path, include it verbatim in the prompt.
- If the user gave only a filename, write "命名为 <filename>" or "save as <filename>" in the prompt.
- If the user gave neither, pick a short filename derived from the subject (e.g. `eagle.png`, `cyberpunk-city.png`) and include it in the prompt.

Don't rewrite the user's creative description more than necessary — they may have specific aesthetic intent. Just ensure the save instruction is unambiguous.

## Output directory safety

Before running, if the target directory doesn't exist, create it first:

```bash
mkdir -p <target-dir>
```

This avoids codex failing on a missing folder.

## After the command runs

1. Confirm the file was actually written: `ls -la <path>` or `test -f <path>`.
2. If the file exists, tell the user the absolute path.
3. If the file was NOT written, show codex's stderr to the user — don't silently retry with different flags.

## Worked examples

**User says:** "帮我在当前目录生成一个鹰在天空中飞翔的画面, 命名为 test.png"

```bash
codex -a never exec -s danger-full-access --skip-git-repo-check \
  "帮我在当前目录生成一个鹰在天空中飞翔的画面, 命名为 test.png"
```

**User says:** "帮我生成一个鹰在天空中飞翔的画面, 保存到当前目录，然后存储为 ./test/image.png" (working in /Users/fun/SII/Research/game_generate)

```bash
mkdir -p /Users/fun/SII/Research/game_generate/test
codex -a never exec -s danger-full-access \
  --cd /Users/fun/SII/Research/game_generate \
  --skip-git-repo-check \
  "帮我生成一个鹰在天空中飞翔的画面, 保存到当前目录，然后存储为 ./test/image.png"
```

**User says:** "帮我生成一个鹰在天空中飞翔的画面, 存储为 /Users/fun/SII/Research/game_generate/test/image.png"

```bash
mkdir -p /Users/fun/SII/Research/game_generate/test
codex -a never exec -s danger-full-access \
  --cd /Users/fun/SII/Research/game_generate \
  --skip-git-repo-check \
  "帮我生成一个鹰在天空中飞翔的画面, 存储为 /Users/fun/SII/Research/game_generate/test/image.png"
```

**User says (no path at all):** "画一张赛博朋克城市的图"

```bash
codex -a never exec -s danger-full-access --skip-git-repo-check \
  "生成一张赛博朋克风格的城市图片，命名为 cyberpunk-city.png"
```

Then tell the user: "已生成 cyberpunk-city.png 到当前目录。"

## Common pitfalls

- **Don't drop `--skip-git-repo-check`** — codex refuses to run with `danger-full-access` outside a git repo without it.
- **Don't drop the quotes around the prompt** — Chinese characters and shell metacharacters will otherwise break the command.
- **Don't run codex from Claude's working dir when the user clearly intends a different project root.** When the user mentions "当前目录" along with a specific project name or path, use `--cd` to anchor codex there.
- **Don't add other flags** the user didn't ask for. The four flags above are the contract.
- **Don't substitute `danger-full-access` with a safer sandbox mode.** The user has accepted this as the fixed contract.