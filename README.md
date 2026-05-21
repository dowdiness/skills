# Dowdiness Skills

A curated collection of agent skills for MoonBit work, project-specific coding patterns, and reusable agent workflows.

This repository follows the same basic shape as Anthony Fu's `antfu/skills`: `skills/` is the shareable output, `meta.ts` records where each skill comes from, and scripts provide lightweight validation for keeping the collection installable.

## Installation

When published on GitHub, install selected skills with the Agent Skills CLI:

```bash
pnpx skills add dowdiness/skills --skill='*'
```

For local development on this machine:

```bash
git clone --recursive https://github.com/dowdiness/skills.git
cd skills
./scripts/install.sh
```

If duplicates still exist from previous sessions, run the repair pass first:

```bash
./scripts/install.sh --repair
```

This backs up conflicting paths to:

`$HOME/.local/share/dowdiness-skills-backup/<timestamp>`

Then rerun `./scripts/install.sh` for strict mode.

This symlinks every directory in `skills/` into:

- `~/.agents/skills/`
- `~/.claude/skills/`
- `~/.codex/skills/`

## Uninstallation

Remove only symlinks that point back to this repository:

```bash
./scripts/uninstall.sh
```

## Repair duplicate skills safely

If you encounter duplicate or leftover skill paths in agent directories, use the cleanup script in dry-run mode first:

```bash
./scripts/cleanup-duplicate-skills.sh
```

If the listed entries are expected duplicates, apply the move to backup:

```bash
./scripts/cleanup-duplicate-skills.sh --apply
```

Then re-run local installation:

```bash
./scripts/install.sh
```

To rollback from a previous backup directory, use:

```bash
./scripts/cleanup-duplicate-skills.sh --restore <backup-dir>
```

To verify duplicate state without moving files, use:

```bash
./scripts/cleanup-duplicate-skills.sh --check
```

The cleanup script is conservative:

- it only targets directories that match skill names in `skills/`
- it keeps symlinks that already point to this repository
- it skips unrelated files/dirs so only confirmed duplicates are moved
- it places moved entries under a timestamped backup directory for easy restore

The same actions are also available through npm:

```bash
npm run install-local
npm run uninstall-local
```

## Skills

| Skill | Origin | Description |
|---|---|---|
| `moonbit` | manual | Router for the MoonBit skill family. |
| `moonbit-agent-guide` | vendor | Official MoonBit coding, layout, and tooling guide. |
| `moonbit-c-binding` | vendor | Official native C binding and FFI guide. |
| `moonbit-refactoring` | vendor | Official idiomatic MoonBit refactoring guide. |
| `moonbit-agent-setup` | vendor | Bootstraps project instructions for Codex, Claude Code, and generic agents. |
| `moonbit-deprecated-syntax` | vendor | Tracks deprecated MoonBit syntax and replacement patterns. |
| `moonbit-error-handling` | vendor | Error type, abort/fail/raise, and recovery boundary guidance. |
| `moonbit-expression-problem` | vendor | Finally Tagless and two-layer extensibility patterns in MoonBit. |
| `moonbit-housekeeping` | vendor | Repo maintenance workflow with BAML-backed worker output parsing. |
| `moonbit-opaque-types` | vendor | Opaque/newtype public API design patterns. |
| `moonbit-perf-investigation` | vendor | Measurement-first performance investigation workflow. |
| `moonbit-refactoring-safety` | vendor | Safety discipline for boundary-crossing MoonBit refactors. |
| `moonbit-traits` | vendor | Practical trait patterns for MoonBit's Self-based trait system. |
| `moonbit-verification` | vendor | MoonBit quality checklist for dependencies, syntax, tests, and interfaces. |
| `incr` | vendor | User-owned library skill for the `dowdiness/incr` reactive library. |
| `loom` | vendor | User-owned library skill for the `dowdiness/loom` parser framework. |
| `handoff` | manual | End-of-session ritual for memory updates, next-session prompts, and clear readiness. |
| `orchestrate` | manual | Cross-repo and multiagent session setup with delegation checkpoints and worker-output intake. |
| `tuple-wrapper-api-style` | manual | Tuple wrapper API style for stable public constructors and concise internals. |

## Repository Layout

```text
skills/      Final shareable skill directories. Each child has a SKILL.md.
sources/     Source repositories or notes used to generate/sync skills.
vendor/      Upstream or user-owned vendor source markers.
scripts/     Local validation and catalog helpers.
meta.ts      Canonical skill source metadata.
```

## Vendor Repositories

Like `antfu/skills`, source repositories used for vendored skills live under `vendor/` as Git submodules.

```bash
git submodule update --init --recursive
```

Current vendor sources:

- `vendor/moonbitlang/moonbit-agent-guide` -> `https://github.com/moonbitlang/moonbit-agent-guide`
- `vendor/dowdiness/moonbit-skills` -> `https://github.com/dowdiness/moonbit-skills`
- `vendor/dowdiness/incr` -> `https://github.com/dowdiness/incr`
- `vendor/dowdiness/loom` -> `https://github.com/dowdiness/loom`

The installable skill output remains under `skills/`. Update the source repository first, then sync the corresponding skill output here:

- `vendor/moonbitlang/moonbit-agent-guide/moonbit-agent-guide/SKILL.md` -> `skills/moonbit-agent-guide/SKILL.md`
- `vendor/moonbitlang/moonbit-agent-guide/moonbit-c-binding/SKILL.md` -> `skills/moonbit-c-binding/SKILL.md`
- `vendor/moonbitlang/moonbit-agent-guide/moonbit-refactoring/SKILL.md` -> `skills/moonbit-refactoring/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-agent-setup/SKILL.md` -> `skills/moonbit-agent-setup/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-deprecated-syntax/SKILL.md` -> `skills/moonbit-deprecated-syntax/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-error-handling/SKILL.md` -> `skills/moonbit-error-handling/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-expression-problem/SKILL.md` -> `skills/moonbit-expression-problem/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-housekeeping/SKILL.md` -> `skills/moonbit-housekeeping/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-opaque-types/SKILL.md` -> `skills/moonbit-opaque-types/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-perf-investigation/SKILL.md` -> `skills/moonbit-perf-investigation/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-refactoring-safety/SKILL.md` -> `skills/moonbit-refactoring-safety/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-traits/SKILL.md` -> `skills/moonbit-traits/SKILL.md`
- `vendor/dowdiness/moonbit-skills/moonbit-verification/SKILL.md` -> `skills/moonbit-verification/SKILL.md`
- `vendor/dowdiness/incr/skills/incr/SKILL.md` -> `skills/incr/SKILL.md`
- `vendor/dowdiness/loom/skills/loom/SKILL.md` -> `skills/loom/SKILL.md`

For vendor skills, treat the source repository as authoritative. Do not edit the synced copy in `skills/` directly except for sync metadata.

## Maintenance

Validate the collection before publishing changes:

```bash
npm run validate
```

Validation also checks vendored skills for drift: every entry with `sourceSkillPath` and `outputPath` in `meta.ts` must match its source directory, excluding `SYNC.md`.

Sync all vendored skills from their source repositories:

```bash
npm run sync-vendor
```

Sync selected vendored skills by name:

```bash
npm run sync-vendor -- moonbit-housekeeping incr
```

Preview drift without writing files:

```bash
npm run sync-vendor -- --dry-run
```

List the catalog derived from `skills/*/SKILL.md`:

```bash
npm run list
```

Keep generated or synced skills concise. Prefer updating the upstream source and then syncing into `skills/`; do not let local copies drift silently.

## Notes

The current initial import is intentionally conservative. UI/design skills and third-party best-practice skills installed locally are not copied until their licenses and source-of-truth repositories are explicitly recorded.
