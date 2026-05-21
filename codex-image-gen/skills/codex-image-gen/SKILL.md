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
- `-s workspace-write` — allows writing files in the workspace
- `--cd <DIR>` — ALWAYS specify a working directory (see rules below)
- `--skip-git-repo-check` — don't refuse to run outside a git repo

Template:

```bash
codex -a never exec -s workspace-write --cd <WORKDIR> --skip-git-repo-check "<PROMPT>"
```

**CRITICAL**: The `--cd` flag is MANDATORY. If the user doesn't specify a directory, use Claude's current working directory. This ensures proper permissions.

## Working directory rules

**ALWAYS include `--cd` with an appropriate directory:**

1. **No path mentioned, or only a bare filename** (e.g. "命名为 test.png", or no filename at all)
   → Use Claude's current working directory: `--cd $(pwd)`
   Example: `codex -a never exec -s workspace-write --cd $(pwd) --skip-git-repo-check "生成一只鹰在天空飞翔的画面，命名为 test.png"`

2. **Relative path** (e.g. "./images/test.png", "output/image.png")
   → Use Claude's current working directory: `--cd $(pwd)` and keep the relative path in the prompt
   Example: `codex -a never exec -s workspace-write --cd $(pwd) --skip-git-repo-check "生成鹰在飞翔的画面，保存到 ./images/test.png"`

3. **Absolute path** (e.g. "/Users/fun/.../image.png")
   → Extract the parent directory for `--cd` and use the absolute path in the prompt
   Example: `codex -a never exec -s workspace-write --cd /Users/fun/projects --skip-git-repo-check "生成鹰在飞翔的画面，存储为 /Users/fun/projects/images/test.png"`

**Note**: The prompt can contain either relative or absolute paths - codex will handle both correctly as long as `--cd` is set properly.

## Prompt construction

**CRITICAL: Pass the user's prompt EXACTLY as they wrote it. DO NOT modify, expand, or "improve" their creative description.**

Only handle the filename:

- If the user specified a path/filename → use their EXACT prompt unchanged
- If the user didn't specify a filename → append ONLY: ", 命名为 <filename>.png"
  - The filename should be a simple 1-3 word description based on the main subject
  - Use English for English prompts, Chinese pinyin or English for Chinese prompts
  
Examples:
- User: "帮我懒羊羊在青青草原上吃饭的图片"
  → Pass: "帮我懒羊羊在青青草原上吃饭的图片, 命名为 lazy-sheep.png"
  
- User: "a cat sitting on a chair"  
  → Pass: "a cat sitting on a chair, save as cat-chair.png"

- User: "画一个苹果, 保存为 apple.png"
  → Pass: "画一个苹果, 保存为 apple.png" (unchanged - already has filename)

- User: "生成赛博朋克城市"
  → Pass: "生成赛博朋克城市, 命名为 cyberpunk-city.png"

**NEVER add creative details like:**
- ❌ "卡通风格", "色彩鲜艳", "高清", "细节丰富"
- ❌ Character descriptions not in the original prompt
- ❌ Scene details not in the original prompt
- ❌ ANY creative modifications or "improvements"

**The user's exact words are sacred - only add the filename if missing!**

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
codex -a never exec -s workspace-write --cd $(pwd) --skip-git-repo-check \
  "帮我在当前目录生成一个鹰在天空中飞翔的画面, 命名为 test.png"
```

**User says:** "帮我生成一个鹰在天空中飞翔的画面, 保存到当前目录，然后存储为 ./test/image.png" (working in /Users/fun/SII/Research/game_generate)

```bash
mkdir -p ./test
codex -a never exec -s workspace-write \
  --cd $(pwd) \
  --skip-git-repo-check \
  "帮我生成一个鹰在天空中飞翔的画面, 保存到 ./test/image.png"
```

**User says:** "帮我生成一个鹰在天空中飞翔的画面, 存储为 /Users/fun/SII/Research/game_generate/test/image.png"

```bash
mkdir -p /Users/fun/SII/Research/game_generate/test
codex -a never exec -s workspace-write \
  --cd /Users/fun/SII/Research/game_generate \
  --skip-git-repo-check \
  "帮我生成一个鹰在天空中飞翔的画面, 存储为 /Users/fun/SII/Research/game_generate/test/image.png"
```

**User says (no path at all):** "画一张赛博朋克城市的图"

```bash
codex -a never exec -s workspace-write --cd $(pwd) --skip-git-repo-check \
  "生成一张赛博朋克风格的城市图片，命名为 cyberpunk-city.png"
```

Then tell the user: "已生成 cyberpunk-city.png 到当前目录。"

## Common pitfalls

- **Don't drop `--skip-git-repo-check`** — codex may refuse to run outside a git repo without it.
- **Don't drop the quotes around the prompt** — Chinese characters and shell metacharacters will otherwise break the command.
- **Don't run codex from Claude's working dir when the user clearly intends a different project root.** When the user mentions "当前目录" along with a specific project name or path, use `--cd` to anchor codex there.
- **Don't add other flags** the user didn't ask for. The five flags above are the contract.
- **workspace-write is sufficient** — it provides the necessary permissions for image generation.