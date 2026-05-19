# Generic Agent Adapter

Use this adapter when the target agent is unknown or the user wants portable instructions.

## Outputs

- Prefer `docs/development/agent-guide.md` if a `docs/development/` directory exists.
- Otherwise use `AGENT-GUIDE.md` at the repository root.
- Do not create product-specific config directories such as `.claude/` or `.agents/`.
- Do not assume hooks, imports, slash commands, or subagents exist.

## Guide Shape

````markdown
# Agent Guide

## Project Context
<one-line purpose and important repository facts>

## Commands

```bash
cd <module> && moon check && moon test
moon info && moon fmt
```

## Documentation
Browse `docs/` for architecture, decisions, development guides, and active plans.

## MoonBit Notes
<repo-specific gotchas only>

## Safety Rules
Do not delete branches, remove worktrees, publish packages, or rewrite history without explicit user confirmation.
````

## Merge Rules

- Merge by Markdown headings.
- Preserve existing project-specific text.
- Keep generic language rules short and link to the installed MoonBit base file only as optional context.
