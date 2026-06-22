# Scripts

Helper scripts for validation, local installation, cleanup, and vendor sync.

## Validate

```bash
npm run validate
```

Checks:
- Each skill in `skills/` has `SKILL.md` with matching frontmatter `name` and `description`.
- Each extension in `extensions/` has a default export function.
- Every directory in `skills/` and `extensions/` is listed in `meta.ts`, and vice versa.
- Vendored skills and extensions show no drift from their submodule sources.

## Install / Uninstall / Cleanup (local symlink)

Symlink this checkout's skills and extensions into the agent auto-discovery directories (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/extensions`).

```bash
npm run install-local                # skip correct links, block conflicts
npm run install-local -- --repair    # back up conflicts, then link
npm run uninstall-local              # remove only symlinks pointing into this repo
```

When duplicates exist outside this repo (e.g. a stale copy in `~/.agents/skills` that is not a symlink to this checkout), use the cleanup helper:

```bash
nu scripts/cleanup-duplicate-skills.nu             # dry run
nu scripts/cleanup-duplicate-skills.nu --check     # report without changes
nu scripts/cleanup-duplicate-skills.nu --apply     # back up duplicates to ~/.local/share/dowdiness-skills-backup/
nu scripts/cleanup-duplicate-skills.nu --restore <backup-dir>
```

## Pi package migration note

The preferred install path is now the pi package (`pi install git:github.com/dowdiness/skills`), which places resources under `~/.pi/agent/`. Local symlink installation targets the older agent discovery directories. If you switch from local symlinks to the pi package, run `npm run uninstall-local` first so that `pi install` does not encounter conflicts.

## Pi package install helper

```bash
npm run install-pi-package
```

Runs `pi install git:github.com/dowdiness/skills` without duplicate resource warnings:

1. backs up local skills/extensions that would collide,
2. installs or updates the pi package,
3. disables this package's pi skill resources in `settings.json`, and
4. recreates `~/.agents`, `~/.claude`, and `~/.codex` skill symlinks to the installed package.

That keeps package-managed extensions active while preserving compatibility with hosts that still discover skills from `~/.agents/skills`. Backups go to `~/.pi/agent/dowdiness-skills-local-backup-<timestamp>/`.

Options:

```bash
node scripts/install-pi-package.mjs --dry-run             # show what would be backed up
node scripts/install-pi-package.mjs --no-install          # back up/link only; skip pi install
node scripts/install-pi-package.mjs --keep-package-skills # do not filter package skills or create compatibility symlinks
node scripts/install-pi-package.mjs <source>              # install from a different source
```

## Sync vendor content

Check whether vendored skills or extensions have drifted from their submodule sources:

```bash
npm run sync-status                  # skills only, dry run
npm run sync-extensions-status       # extensions only, dry run
```

Apply the sync (copy from submodule source into `skills/` or `extensions/` and record the upstream SHA):

```bash
npm run sync-vendor                  # skills
npm run sync-vendor-extensions       # extensions
```

You can also sync a single vendor entry by name:

```bash
node scripts/sync-vendor-skills.mjs moonbit-agent-guide
```

## List skills

```bash
npm run list
```

Prints each skill and extension with its description (from SKILL.md frontmatter or extension metadata).
