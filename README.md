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

Direct `pi install` and Agent Skills-only installation do not install
`agents/*.md`; use the repository helper before using `parallel-review`.
The skill is supported for MoonBit/Canopy repositories only.

Before running a review, confirm that the configured model providers are
approved for the repository. The parent supplies the complete diff or relevant
hunks to the coordinator, which passes that context to all four reviewers. The
skill does not redact secrets or proprietary content.

Install skills only with the Agent Skills CLI:

```bash
pnpx skills add dowdiness/skills --skill='*'
```

Skill-only installation still requires the repository helper (or manual
installation of the 16 agent definitions) before agent workflows can run.

## What's included

- [`skills/`](skills/) — MoonBit, incr, loom, handoff, orchestration, and API-style skills.
- [`agents/`](agents/) — the complete bundle of 16 agent definitions, including planning, implementation, scouting, documentation, and review workflows.
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

## Canopy scheduler integration

The scheduler integration is supported for Canopy repositories. It selects the
Canopy profile from repository markers or explicit Canopy configuration and
provides the `parallel-review` route:

```text
/scheduler on
/scheduler parallel-review inspect the current diff
```

The packaged coordinator and four specialized reviewer agents are required.
The generic profile implementation remains internal and is not a supported
third-party workflow. Its standalone design, agent provisioning, provider
configuration, and validation coverage are tracked in [issue #7](https://github.com/dowdiness/skills/issues/7).

## Source of truth

`meta.ts` is the catalog for skill, agent, and extension ownership.

For vendored content, update the upstream/source repo first, then sync this repo. Do not let copied outputs in `skills/` or `extensions/` drift silently.
