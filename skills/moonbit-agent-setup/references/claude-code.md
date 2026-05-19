# Claude Code Adapter

Use this adapter when the target is Claude Code.

## Outputs

- Generate or merge `CLAUDE.md`.
- Generate or merge `.claude/settings.json` only when the user wants hooks.
- Use `~/.claude/moonbit-base.md` for shared MoonBit conventions.
- Do not generate Codex-only files for a Claude-only setup.

## Hook Schema

Claude Code hooks use `PreToolUse`, `PostToolUse`, and `SessionStart`. Do not invent keys such as `PreCommit`.

Minimal hook config:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git commit*)",
        "hooks": [
          {
            "type": "command",
            "command": "moon check && moon test",
            "timeout": 120
          }
        ]
      },
      {
        "matcher": "Bash(git push*)",
        "hooks": [
          {
            "type": "command",
            "command": "git submodule foreach 'git diff --exit-code @{push}.. 2>/dev/null || echo WARNING: unpushed submodule commits in $name'",
            "timeout": 30,
            "statusMessage": "Checking for unpushed submodule commits..."
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "moon check 2>&1 | head -20"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "moon update",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

For multi-module repositories, replace the commit hook command with relative per-module checks:

```bash
cd <module1> && moon check && moon test && cd ../<module2> && moon check && moon test
```

## CLAUDE.md Shape

Use this section order:

1. `# Project title`
2. `@~/.claude/moonbit-base.md`
3. `## MoonBit Language Notes`
4. `## Commands`
5. `## Documentation`
6. `## Development Workflow`
7. `## MoonBit Conventions`
8. `## Design Context`

Keep `CLAUDE.md` project-specific. Do not include a static package map; prefer `moon ide outline <path>` or an optional `scripts/package-overview.sh`.

## Merge Rules

- Preserve unrelated `.claude/settings.json` keys such as `permissions`.
- Deduplicate hook entries by matcher and command.
- Do not run `moon fmt` inside a pre-commit hook because it changes files during commit checks.
- Use relative paths from the project root.
