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
./scripts/install.sh
```

This symlinks every directory in `skills/` into:

- `~/.agents/skills/`
- `~/.claude/skills/`

## Uninstallation

Remove only symlinks that point back to this repository:

```bash
./scripts/uninstall.sh
```

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
| `moonbit-agent-setup` | manual | Bootstraps project instructions for Codex, Claude Code, and generic agents. |
| `moonbit-deprecated-syntax` | manual | Tracks deprecated MoonBit syntax and replacement patterns. |
| `moonbit-error-handling` | manual | Error type, abort/fail/raise, and recovery boundary guidance. |
| `moonbit-expression-problem` | manual | Finally Tagless and two-layer extensibility patterns in MoonBit. |
| `moonbit-housekeeping` | manual | Repo maintenance workflow with BAML-backed worker output parsing. |
| `moonbit-opaque-types` | manual | Opaque/newtype public API design patterns. |
| `moonbit-perf-investigation` | manual | Measurement-first performance investigation workflow. |
| `moonbit-refactoring-safety` | manual | Safety discipline for boundary-crossing MoonBit refactors. |
| `moonbit-traits` | manual | Practical trait patterns for MoonBit's Self-based trait system. |
| `moonbit-verification` | manual | MoonBit quality checklist for dependencies, syntax, tests, and interfaces. |
| `incr` | vendor | User-owned library skill for the `dowdiness/incr` reactive library. |
| `loom` | vendor | User-owned library skill for the `dowdiness/loom` parser framework. |
| `tuple-wrapper-api-style` | manual | Tuple wrapper API style for stable public constructors and concise internals. |

## Repository Layout

```text
skills/      Final shareable skill directories. Each child has a SKILL.md.
sources/     Source repositories or notes used to generate/sync skills.
vendor/      Upstream skill sources when we copy existing external skills.
scripts/     Local validation and catalog helpers.
meta.ts      Canonical skill source metadata.
```

## Maintenance

Validate the collection before publishing changes:

```bash
npm run validate
```

List the catalog derived from `skills/*/SKILL.md`:

```bash
npm run list
```

Keep generated or synced skills concise. Prefer updating the upstream source and then syncing into `skills/`; do not let local copies drift silently.

## Notes

The current initial import is intentionally conservative. UI/design skills and third-party best-practice skills installed locally are not copied until their licenses and source-of-truth repositories are explicitly recorded.
