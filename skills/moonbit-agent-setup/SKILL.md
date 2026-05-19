---
name: moonbit-agent-setup
description: Set up MoonBit project instructions and agent configuration for coding assistants. Use when bootstrapping agent guidance, validation commands, hooks, project conventions, or shared MoonBit context for Codex, Claude Code, or other agent environments.
---

# MoonBit agent setup

Create project-level agent instructions for a MoonBit repository. Keep the core guidance agent-neutral, then apply the adapter for the active agent only when the user wants tool-specific files or hooks.

## Workflow

1. Detect the repository structure.
2. Detect the active agent target.
3. Generate or merge the appropriate project instruction file.
4. Add optional validation hooks only for agents that support them.
5. Verify the generated files and run a MoonBit sanity check.

## Step 1: detect project structure

Scan from the working directory:

```bash
find . -name "moon.mod.json" -not -path "./.worktrees/*"
find . \( -name "moon.pkg.json" -o -name "moon.pkg" \) -not -path "./.worktrees/*" -not -path "./.mooncakes/*"
find . \( -name "*_test.mbt" -o -name "*_wbtest.mbt" -o -name "*_benchmark.mbt" \) -not -path "./.mooncakes/*" | head -20
test -f .gitmodules && cat .gitmodules
```

Record module names, package paths, test locations, docs directories, and submodule presence.

## Step 2: select adapter

Use one adapter:

| Target | Signals | Output |
|--------|---------|--------|
| Codex | user asks for Codex, `AGENTS.md` exists, `.agents/` exists | `AGENTS.md`, optional helper scripts |
| Claude Code | user asks for Claude, `CLAUDE.md` exists, `.claude/` exists | `CLAUDE.md`, optional `.claude/settings.json` hooks |
| Generic | no clear agent target | `docs/development/agent-guide.md` or another user-approved Markdown file |

If the user names a target, prefer that target over filesystem signals. If multiple targets are requested, generate each adapter separately and avoid cross-linking product-specific files.

Reference files:

- Codex: read `references/codex.md`.
- Claude Code: read `references/claude-code.md`.
- Generic or unknown agent: read `references/generic-agent.md`.

## Step 3: generate core content

Every adapter should include the same project-specific information:

- Project title and one-line purpose.
- Module and package commands discovered from `moon.mod.json`.
- MoonBit-specific gotchas tied to this project.
- Documentation rules if `docs/` exists.
- Development workflow rules that cannot be enforced mechanically.
- Pointers to local scripts and reference docs.

Keep generated instruction files short. Put stable shared MoonBit conventions in the installed base file:

- Codex: `~/.agents/moonbit-base.md`
- Claude Code: `~/.claude/moonbit-base.md`

Use an import only when the target agent supports that instruction-file syntax. Otherwise, summarize the relevant rules briefly and point to the base file.

## Step 4: merge idempotently

If the target file already exists:

1. Read the existing file.
2. Parse Markdown section headings.
3. Preserve user-written content.
4. Add missing sections in the expected order.
5. Do not delete or rewrite existing sections unless the user explicitly asks.

If adding JSON config for an adapter:

1. Read the existing JSON.
2. Parse and merge by key.
3. Skip duplicate hook commands.
4. Preserve unrelated keys.
5. Never overwrite the entire file.

## Step 5: verify

Run the checks that match the generated adapter:

```bash
moon check
```

If JSON config was written:

```bash
python3 -m json.tool <path-to-config-json>
```

If an instruction file was generated or merged, inspect the first section order:

```bash
head -80 <instruction-file>
```

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Treating Claude Code as the default | Select an adapter first |
| Writing product-specific details into the core workflow | Move them to `references/<adapter>.md` |
| Overwriting an existing instruction file | Merge by headings and preserve user text |
| Listing every doc file | Say how to browse docs and capture only durable rules |
| Embedding generic MoonBit rules in every project | Use the installed base file when supported |
| Hardcoding absolute paths | Use paths relative to the project root |
