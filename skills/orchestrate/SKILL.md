---
name: orchestrate
description: >
  Cross-repo and multiagent session setup workflow. Use when Codex needs to
  choose or verify the target repository, isolate work in a branch or worktree,
  decide whether to delegate to workers, supervise structured worker output, or
  coordinate coding work across multiple repos without mixing product contexts.
---

# Orchestrate

Prepare cross-repo or multiagent work so the right repository, isolation boundary, delegation policy, verification plan, and stop condition are explicit before edits begin.

## Start Gate

1. Confirm the target repo from the user's latest request. If multiple repos are plausible, stop and ask; do not infer from recent conversation alone.
2. Run a clean-state check in the target repo before editing:
   ```bash
   git status --short --branch
   ```
3. Create a dedicated branch or worktree for the target repo before edits. Keep unrelated product repos out of scope. Example anti-confusion check: work in `dowdiness/skills` for skill packaging, not a recent Canopy product branch.
4. Read the repo's local agent instructions first: `AGENTS.md`, any referenced instruction files, public inventory docs, catalog/source-of-truth files, and the specific precedents named by the task.
5. State a short design note before editing when the deliverable shape is ambiguous: `new skill`, `reference doc`, or `both`, with one sentence of rationale.

## Audit Before Edit

Gather evidence before writing:

- Identify ownership: manual, vendor-synced, generated, or product-local. Edit vendor-synced output only through the authoritative source repo unless the user explicitly targets the synced copy.
- List non-goals and adjacent work that must not bleed in.
- Find validation commands from project docs, not from memory.
- Identify irreversible or global actions: installs, config edits, destructive git commands, publishing, deleting branches, or touching another repo. Ask before any such action unless already authorized.
- Prefer repo-contained docs or skills before global memory/config changes.

## Delegation Decision

Use workers only when the host environment and user instructions permit delegation.

Before delegating, say the decision explicitly:

```text
Delegation check: yes -> <worker/model>, because <specific reason>.
Delegation check: no, because <specific reason>.
```

Delegate when the task is bounded, independently verifiable, and mostly mechanical after the design is fixed: large call-site migrations, read-only surveys, parallel review lenses, schema-constrained reports, or line-for-line FFI/binding work.

Keep the work local when architecture, product judgment, API shape, destructive sequencing, or a small sub-30-line edit is the real work. If writing the worker brief requires reading enough context that only rote edits remain, reverse to local execution.

For delegated work:

- Assign disjoint file or responsibility ownership.
- Tell workers they are not alone in the codebase and must not revert others' changes.
- Give prose specs, invariants, verification commands, and stop conditions. Avoid pasting executable test bodies unless the body itself has been reviewed.
- Bound return size: ask for changed paths, verdicts, short evidence, and no full diffs unless needed.
- Log the decision before dispatch when a delegation log exists; update pending outcomes before session end.

## Worker Intake

Treat worker output as claims until validated.

For structured JSON:

1. Strict-parse the raw output first.
2. Use the known schema parser when available. For `moonbit-housekeeping release`, pipe raw worker output through:
   ```bash
   ~/.claude/skills/moonbit-housekeeping/parse-worker-output.py --root Changelog
   ~/.claude/skills/moonbit-housekeeping/parse-worker-output.py --root ApiReview
   ~/.claude/skills/moonbit-housekeeping/parse-worker-output.py --root DocDrift
   ```
   For parallel review findings with a shared schema, prefer `--root ReviewFindings`.
3. If parsing fails, re-request JSON-only from the worker instead of accepting prose.
4. Validate every material claim against file, line, diff, command, or test evidence before including it in the parent review.

Do not claim trailing commas are supported; `e2-trailing-comma` is expected to fail in the parser regression suite.

## Verification Plan

Before editing, name the checks that define done. After editing, run them and report exact pass/fail status.

Use layered verification:

- Repo catalog or packaging checks, such as `npm run validate` and `npm run list` for a skills repo.
- Project build, typecheck, test, lint, format, or generated-interface checks from local docs.
- `git diff --check` before final handoff.
- Independent review or browser/manual checks when tests cannot see the behavior.

If a worker claims verification passed, re-run the critical commands locally when feasible. If sandbox, network, or environment limits block verification, say exactly what was not run.

## Memory And Handoff

- Do not update durable memory for uncommitted code unless the user explicitly asks; memory should record committed or otherwise persisted reality.
- Use absolute dates in persistent notes.
- Keep repo-contained deliverables first. Do not install skills globally, edit global Codex/Claude config, or modify product-repo memories unless requested.
- Before ending a delegated session, sweep for pending worker outcomes and close or label them unresolved.
- If preparing a next-session prompt, make it self-contained and cite artifacts that survive context clearing.

## Stop Conditions

Stop and ask or report a blocker when:

- The target repo is ambiguous or the current directory conflicts with the request.
- Local instructions conflict with the requested edit.
- A vendor/generated output would need direct edits but its source repo is not the target.
- Required worker output cannot be parsed or independently validated.
- Verification fails and the fix would expand beyond the agreed scope.
- The next step is destructive, global, publishing-related, or crosses into a non-target repo.
