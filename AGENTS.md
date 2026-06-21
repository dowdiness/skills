# Project Instructions

@/home/antisatori/.codex/RTK.md

## Project Context

This repository is a shareable collection of pi agent skills and extensions. The installable skill output is `skills/*/SKILL.md`. Extension output lives in `extensions/*.ts` (single-file) or `extensions/*/index.ts` (directory).

Use `meta.ts` as the source-of-truth catalog for ownership and sync source. Use `README.md` for the public-facing inventory.

## Commands

```bash
rtk npm run validate
rtk npm run list
rtk ./scripts/install.nu
rtk ./scripts/uninstall.nu
rtk npm run install-local
rtk npm run uninstall-local
rtk npm run sync-extensions-status
rtk npm run sync-vendor-extensions
rtk git submodule update --init --recursive
```

## Skill Authoring Rules

- Keep each skill concise and agent-facing.
- Do not copy long user-facing docs verbatim; rewrite into practical agent workflows.
- Keep optional deep context in `references/` and load it only when needed.
- Put deterministic helper code in `scripts/` inside the skill directory when useful.
- Preserve bundled resources that a skill needs at runtime.

## Source Categories

- `manual`: written or curated in this repository.
- `vendor`: copied from an upstream or user-owned source repository; prefer source-repo changes before local edits.
- `generated`: produced from source documentation; update by comparing against the recorded source revision.

Vendor source repositories live under `vendor/` as Git submodules. The installable output still lives under `skills/`; do not point users at `vendor/` for skill installation.

When adding a skill, update `meta.ts`, `README.md`, and run `npm run validate`.

## Extension Authoring Rules

- Extensions are `.ts` files exporting a default factory `(pi: ExtensionAPI) => void`.
- Single-file extensions go in `extensions/name.ts`.
- Multi-file extensions go in `extensions/name/index.ts` with helper modules alongside.
- Keep extensions focused on a single concern.
- Use `pi.registerTool()`, `pi.registerCommand()`, and `pi.on()`; see the pi `extensions.md` docs for the full API.
- Extensions run with full system access; review carefully before sharing.

## Extension Source Categories

Same categories as skills: `manual`, `vendor`, `generated`. Vendor extension source repos live under `vendor/` as Git submodules. The installable output lives under `extensions/`.
