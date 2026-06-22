# Dowdiness Skills

Agent skills and pi extensions for MoonBit work, project-specific coding patterns, and reusable workflows.

This repo is both:

- a skill collection (`skills/*/SKILL.md`)
- a pi package (`package.json` → `pi.skills` and `pi.extensions`)

## Install

Install the full pi package:

```bash
pi install git:github.com/dowdiness/skills
pi list
pi --offline --no-session --no-tools -p "respond ok"
```

If you already have local copies of these skills or extensions, use the conflict-safe helper from a checkout:

```bash
git clone --recursive https://github.com/dowdiness/skills.git
cd skills
npm run install-pi-package
```

The helper backs up colliding local resources, installs the package, and keeps compatibility symlinks for hosts that still read `~/.agents/skills`.
See [`scripts/README.md`](scripts/README.md#pi-package-install-helper).

Install skills only with the Agent Skills CLI:

```bash
pnpx skills add dowdiness/skills --skill='*'
```

## What's included

- [`skills/`](skills/) — MoonBit, incr, loom, handoff, orchestration, and API-style skills.
- [`extensions/`](extensions/) — pi extensions for subagent delegation and Canopy scheduling.
- [`scripts/`](scripts/) — validation, local install, cleanup, and vendor-sync helpers.
- [`vendor/`](vendor/) — submodule sources for vendored skills.
- [`sources/`](sources/) — notes for generated or historical source material.

## Common commands

```bash
npm run validate
npm run list
npm run sync-status
npm run sync-extensions-status
```

For local symlink installation, cleanup, and migration details, see [`scripts/README.md`](scripts/README.md).

## Source of truth

`meta.ts` is the catalog for skill and extension ownership.

For vendored content, update the upstream/source repo first, then sync this repo. Do not let copied outputs in `skills/` or `extensions/` drift silently.
