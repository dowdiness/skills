# Generic Scheduler Profile Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with a verification checkpoint after each file edit.

**Goal:** Replace the Canopy-specific scheduler policy with a reusable scheduler engine driven by a declarative project profile while preserving Canopy behavior.

**Architecture:** Keep process execution, routing orchestration, patch capture, validation execution, UI progress, and route history in the scheduler engine. Move route vocabulary, agent aliases, classifier prompt, validation rules, generated-file policy, autopilot limits, and project detection into a declarative profile module. Ship the existing Canopy behavior as the default profile and add a generic fallback profile.

**Tech Stack:** TypeScript, Bun/Node built-ins, pi ExtensionAPI, repository-local validation scripts.

## Global Constraints

- `meta.ts` remains the ownership/catalog source of truth.
- `README.md` remains the public inventory.
- The extension remains one focused concern, with cohesive helper modules under `extensions/scheduler/`.
- Preserve `/scheduler` command compatibility and Canopy route behavior.
- Do not identify projects by absolute checkout pathname.
- Do not claim live provider-backed agent execution in tests; use deterministic unit/smoke harnesses.
- Run `npm run validate` after implementation and `git diff --check` before completion.

## File Map

- Create `extensions/scheduler/profile.ts`: profile interfaces, generic fallback profile, Canopy profile, profile detection.
- Create `extensions/scheduler/engine.ts`: profile-independent route/run helpers extracted from the current extension.
- Modify `extensions/scheduler/index.ts`: extension adapter, command/UI lifecycle, profile resolution, and compatibility entry point.
- Remove `extensions/canopy-scheduler/index.ts` after the compatibility entry point is migrated.
- Modify `meta.ts`, `README.md`, `scripts/README.md`, `scripts/validate.mjs`, and package catalog entries to describe the generic scheduler.
- Add deterministic tests or a Bun harness under `extensions/scheduler/` for profile detection and route mapping.

## Tasks

### Task 1: Define profile contract

- Add a `SchedulerProfile` interface covering identity, route definitions, classifier vocabulary, validation policy, generated path policy, and automation limits.
- Define route steps as data (`agent`, task template, isolation mode) so the engine does not switch on Canopy route names.
- Define `ProjectDetector` as a pure/async predicate over cwd and changed paths.
- Export `genericProfile`, `canopyProfile`, and `resolveSchedulerProfile`.
- Ensure fallback profile supports `mechanic`, `scout`, `plan`, `review`, `implement`, and `worker` without MoonBit assumptions.

### Task 2: Move Canopy policy into the profile

- Move MoonBit route aliases, MoonBit classifier vocabulary, Canopy review context, MoonBit validation command selection, generated path patterns, and cautious autopilot limits into `canopyProfile`.
- Keep agent names and prompts in profile data; retain only template interpolation in engine code.
- Preserve `parallel-review` as an explicit Canopy route and preserve the four-reviewer coordinator handoff.

### Task 3: Refactor the engine

- Extract process execution, agent loading, isolated worktree execution, patch capture, apply-check, validation execution, and route result aggregation into `engine.ts`.
- Replace hard-coded `switch (route.kind)` behavior with profile route definitions plus generic step execution.
- Keep multi-step plan/implement flows expressible through profile step templates and previous-step output interpolation.
- Pass generated-file policy, validation policy, and autopilot policy into engine functions.

### Task 4: Replace pathname detection

- Resolve the nearest repository root and inspect project markers/configuration instead of checking `/dowdiness/canopy` in the path.
- Prefer explicit profile config, then repository markers, then generic fallback.
- Make Canopy detection work from worktrees and alternate clones.
- Default generic profiles to `off` unless explicitly enabled, while preserving Canopy's current default mode.

### Task 5: Migrate extension entry point and catalog

- Rename the extension directory to `extensions/scheduler/` and update package extension discovery.
- Keep the default export factory and `/scheduler` command surface stable.
- Update `meta.ts`, `README.md`, `scripts/README.md`, and validation/catalog expectations.
- Document profile selection and a minimal example for a non-Canopy repository.

### Task 6: Add focused verification

- Add deterministic checks for generic fallback, Canopy marker detection, alternate clone/worktree detection, explicit route mapping, and profile-specific validation policy.
- Run package validation and a Bun syntax/build check with peer dependencies externalized.
- Run install/uninstall smoke checks if extension paths change.
- Review diff for stale `canopy-scheduler` names and absolute-path detection.
