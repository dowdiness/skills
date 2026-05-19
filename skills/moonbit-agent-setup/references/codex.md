# Codex Adapter

Use this adapter when the target is Codex.

## Outputs

- Prefer a repository-level `AGENTS.md`.
- Use `~/.agents/moonbit-base.md` for shared MoonBit conventions when the instruction file can import external Markdown.
- Do not edit `~/.codex/config.toml` unless the user explicitly asks for Codex configuration changes.
- Do not create `.claude/` files for a Codex-only setup.

## AGENTS.md Shape

Keep `AGENTS.md` concise and project-specific:

````markdown
# Project Instructions

@~/.agents/moonbit-base.md

## Project Context
<one-line purpose and important repository facts>

## Commands

```bash
cd <module> && moon check && moon test
moon info && moon fmt
```

## Documentation
Browse `docs/` for architecture, decisions, development guides, and active plans.
Code is the source of truth when docs and implementation disagree.

## Project-Specific MoonBit Notes
<only gotchas specific to this repo>
````

If the current Codex environment does not support `@` imports, inline only the few shared rules needed for this repository and mention the base file path.

## Merge Rules

- If `AGENTS.md` exists, add missing sections without removing existing text.
- Keep generated sections under 80 lines where possible.
- Do not duplicate hook behavior as prose if a project already has scripts or CI enforcing it.
- For nested repositories, place `AGENTS.md` at the repository root unless the user asks for folder-specific instructions.

## Optional Helper Script

For repositories where package layout changes often, create `scripts/package-overview.sh` only if useful:

```bash
#!/usr/bin/env bash
set -euo pipefail

find . \( -name "moon.pkg.json" -o -name "moon.pkg" \) -not -path "./.mooncakes/*" -not -path "./.worktrees/*" |
  while read -r pkg; do
    dir="$(dirname "$pkg")"
    echo "=== $dir ==="
    moon ide outline "$dir" 2>/dev/null || true
  done
```

Do not add Codex hooks unless the user asks for a specific hook mechanism.
