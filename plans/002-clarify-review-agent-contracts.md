# Plan 002: Clarify review roles and make coordinator failures explicit

> **Executor instructions**: Follow this plan exactly. Preserve all current
> model and fallback settings. Validate scheduler behavior with tests before
> changing any coordinator runtime contract.
>
> **Drift check (run first)**:
> `git diff --stat 6336d7b..HEAD -- agents/reviewer*.md agents/{ensemble-reviewer,parallel-reviewer,review-router}.md extensions/scheduler skills/parallel-review/SKILL.md`
>
> The execution checkout must contain this plan and the current `model:`,
> `fallbackModels:`, and `tools:` values committed alongside it. Snapshot those
> values before editing. Do not execute from a checkout that lacks this plan or
> the committed frontmatter baseline.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none; coordinate with Plan 001 if both touch nearby prompt text
- **Category**: tech-debt
- **Planned at**: commit `6336d7b`, 2026-07-21; current frontmatter state inspected

## Why this matters

The generic reviewer is heavily used and effective, while specialist reviewer
traffic is sparse and their boundaries are not obvious from the generic prompt.
Model names embedded in descriptions drift whenever model assignments change.
The quick and thorough coordinators also differ in how they report failed leaf
reviews, and historical coordinator failures show that nested `subagent` access
must be wired explicitly rather than assumed.

## Current state

- `agents/reviewer.md:9-30` covers bugs, security, and code smells without
  directing focused tasks to specialist agents.
- `agents/reviewer-correctness.md:1-30`, `reviewer-api-boundary.md:1-31`, and
  `reviewer-idioms.md:1-31` put model names in user-visible descriptions.
- `agents/parallel-reviewer.md:11-80` requires complete context, reviewer status,
  and `INCOMPLETE REVIEW`; `skills/parallel-review/SKILL.md:18-112` matches this
  roster and contract and must remain aligned.
- `agents/ensemble-reviewer.md:9-77` lacks reviewer-status and incomplete-review
  rules.
- `agents/review-router.md:9-39` dispatches another coordinator, introducing a
  nested hop.
- `extensions/scheduler/index.ts:604-623` explicitly supplies the subagent
  extension only to `parallel-reviewer`; coordinator changes must account for
  that runtime behavior.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Structural validation | `rtk npm run validate` | exit 0 |
| Model validation | `rtk npm run validate-agent-models` | exit 0 |
| Scheduler/tests | `rtk npm test` | all tests pass |
| Diff hygiene | `rtk git diff --check` | no output |

Run from `/home/antisatori/ghq/github.com/dowdiness/skills`.

## Scope

**In scope**:
- `agents/reviewer.md`
- `agents/reviewer-correctness.md`
- `agents/reviewer-api-boundary.md`
- `agents/reviewer-idioms.md`
- `agents/ensemble-reviewer.md`
- `agents/review-router.md`
- `extensions/scheduler/index.ts`
- Relevant existing scheduler tests only if runtime wiring changes

**Read-only reference**:
- `agents/parallel-reviewer.md`
- `skills/parallel-review/SKILL.md`

**Out of scope**:
- Changing the four parallel-reviewer leaf roles or roster
- Changing model/fallback values
- Rewriting the parallel-review skill
- Creating a generic non-MoonBit parallel-review product

## Steps

### Step 1: Remove model identity from routing descriptions

Change only the `description:` values of:

- `reviewer-correctness`: describe correctness, edge cases, invariants, and
  semantic regressions.
- `reviewer-api-boundary`: describe public API, package boundary, constructor/
  field visibility, and trait-bound safety.
- `reviewer-idioms`: describe readability, naming, mutation, loops, and project
  idioms.

Do not name providers or models. Do not alter `model:` or `fallbackModels:`.

**Verify**:
`rg -n "description:.*(GPT|Codex|DeepSeek|Qwen|Nemotron|Gemini|MiMo)" agents/*.md`
→ no reviewer description matches.

### Step 2: Define generic versus specialist review boundaries

Add a compact scope section to `agents/reviewer.md`:

- Generic reviewer: broad, risk-sensitive quality/security/maintainability
  review when one independent lens is wanted.
- `reviewer-correctness`: focused bug and semantic regression analysis.
- `reviewer-api-boundary`: exported surface and ownership boundaries.
- `reviewer-idioms`: maintainability and idiomatic structure.
- `moonbit-reviewer`: MoonBit package/API/`.mbti`/validation specialist.

Tell the generic reviewer to report high-confidence findings only, distinguish
observed evidence from inference, and avoid duplicating style-only findings when
the task requested correctness.

**Verify**:
`rg -n "reviewer-correctness|reviewer-api-boundary|reviewer-idioms|moonbit-reviewer|high-confidence" agents/reviewer.md`
→ all role boundaries are present.

### Step 3: Make ensemble review fail closed

Adapt the status contract from `parallel-reviewer.md` into
`ensemble-reviewer.md`:

- Classify every spawned leaf as `usable report received` or
  `failed-or-missing`.
- A usable report requires non-empty `## Files Reviewed` and `## Summary`.
- Add `## Reviewer Status` to the consolidated output, including the conditional
  MoonBit reviewer only when it was dispatched.
- If any required leaf is missing, begin Summary with `INCOMPLETE REVIEW`, name
  missing reviewers, and never claim clean/complete/merge-ready.
- Do not retry manually; preserve runtime fallback notes only when returned.
- Keep the existing quick-review purpose and conditional MoonBit detection.

**Verify**:
`rg -n "Reviewer Status|failed-or-missing|INCOMPLETE REVIEW|Do not.*retry" agents/ensemble-reviewer.md`
→ all fail-closed rules are present.

### Step 4: Resolve nested coordinator runtime deliberately

First inspect the live scheduler and subagent extension behavior. Prefer the
smallest backward-compatible fix:

1. Keep `review-router`'s public behavior (choose and invoke a coordinator).
2. In `extensions/scheduler/index.ts`, ensure every scheduler-launched agent
   whose declared tools include `subagent` receives `SUBAGENT_EXTENSION`, not
   only the literal `parallel-reviewer` name.
3. Add/adjust a scheduler test proving this for `ensemble-reviewer`,
   `parallel-reviewer`, and `review-router` without invoking live models.
4. Keep the strict complete-output post-check specific to `parallel-reviewer`.

If the extension architecture cannot support the router→coordinator→leaf chain
without losing nested `subagent` access, STOP. Do not silently change the router
to decision-only output because that breaks its current public contract; report
that a separate migration plan is required.

**Verify**:
`rtk npm test`
→ scheduler tests pass, including the new extension-selection case.

### Step 5: Recheck parallel-review source alignment

Compare `agents/parallel-reviewer.md` with
`skills/parallel-review/SKILL.md`. Confirm the same four reviewers, context
requirements, status values, and incomplete-review semantics. Do not edit either
file when they remain aligned.

**Verify**:
`rg -n "moonbit-reviewer|reviewer-correctness|reviewer-idioms|reviewer-api-boundary" agents/parallel-reviewer.md skills/parallel-review/SKILL.md`
→ both list the same roster.

### Step 6: Run full verification and inspect scope

Run all commands in “Commands you will need.” Inspect the final diff and confirm
that no model/fallback assignment or parallel-review contract changed.

## Test plan

- Add a deterministic scheduler test around extension selection for each
  subagent-using coordinator.
- Keep existing complete/incomplete parallel-review output tests passing.
- Add no live-model tests in this plan.
- Use the current scheduler test style under `extensions/scheduler/*.test.ts` or
  `*.test.mjs`; do not introduce a second test framework.

## Done criteria

- [ ] Reviewer descriptions contain roles, not model names.
- [ ] Generic and specialist reviewer boundaries are explicit.
- [ ] Ensemble review reports leaf status and fails closed.
- [ ] Scheduler-launched subagent-using agents receive the required extension.
- [ ] Parallel-review Agent and Skill remain unchanged and aligned.
- [ ] All current model/fallback values are preserved.
- [ ] `rtk npm run validate`, `rtk npm run validate-agent-models`, and `rtk npm test` pass.
- [ ] `rtk git diff --check` passes.
- [ ] The row for Plan 002 in `plans/README.md` is updated.

## STOP conditions

- The execution checkout does not contain this plan or its committed frontmatter baseline.
- Fixing nested routing requires changing subagent extension public APIs.
- The router cannot retain its current output contract with deterministic tests.
- Any change would alter the parallel-review roster or MoonBit-only support boundary.

## Maintenance notes

Model assignments belong only in frontmatter. When adding a reviewer, update the
coordinator roster, scheduler completeness checks, parallel-review Skill, tests,
and `meta.ts` together when applicable.
