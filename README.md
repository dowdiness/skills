# Dowdiness Skills

Agent skills and pi extensions for MoonBit work, project-specific coding patterns, and reusable workflows.

This repo is both:

- a pi package (`package.json` → `pi.skills` and `pi.extensions`)
- an agent-definition bundle (`agents/*.md`, linked by the package install helper)

## Install

Install the full bundle, including `parallel-review`'s coordinator and
reviewer agents, from a checkout:

```bash
git clone https://github.com/dowdiness/skills.git
cd skills
npm run install-pi-package
```

The helper backs up colliding local skills, agents, and extensions, installs the
package, and keeps compatibility symlinks for hosts that still read
`~/.agents/skills`. Run `pi --offline --no-session --no-tools -p "respond ok"`
after installation to smoke-test startup.

For skills and extensions only, the package can also be installed directly:

```bash
pi install git:github.com/dowdiness/skills
pi list
```

Direct `pi install` does not install `agents/*.md`; run the repository helper
before using `parallel-review`.

Install skills only with the Agent Skills CLI:

```bash
pnpx skills add dowdiness/skills --skill='*'
```

## What's included

- [`skills/`](skills/) — MoonBit, incr, loom, handoff, orchestration, and API-style skills.
- [`agents/`](agents/) — the `parallel-reviewer` coordinator and four specialized reviewer definitions.
- [`extensions/`](extensions/) — profile-driven scheduler and subagent delegation pi extensions.
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

## Profile-driven scheduler

Profiles are selected in this order: repository `.scheduler.json` or `scheduler.config.json` (`{"profile":"generic"}` or `{"profile":"canopy"}`), Canopy repository markers, then the generic fallback.

Profiles define route vocabulary, agent steps, classifier instructions, generated-file policy, validation rules, and cautious-autopilot limits. A non-Canopy repository can opt in without changing the extension:

```text
/scheduler on
/scheduler review inspect the current diff
/scheduler implement add a focused parser test
```

The `parallel-review` route remains available in Canopy profiles and delegates to the packaged coordinator plus its four specialized reviewer agents.

## Source of truth

`meta.ts` is the catalog for skill, agent, and extension ownership.

For vendored content, update the upstream/source repo first, then sync this repo. Do not let copied outputs in `skills/` or `extensions/` drift silently.
