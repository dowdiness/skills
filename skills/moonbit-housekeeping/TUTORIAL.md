# Housekeeping Tutorial

## When to Use Which Subcommand

```
Opening a session?           -> moonbit-housekeeping          (most common)
Just want a quick glance?    -> moonbit-housekeeping check
Finished a session?          -> moonbit-housekeeping fix
Lost track of priorities?    -> moonbit-housekeeping triage
About to cut a release?      -> moonbit-housekeeping release
```

---

## Subcommands

### `moonbit-housekeeping` - full audit-and-fix (default)

The go-to command. Answers: **"is my repo healthy, and what can be cleaned up?"**

Runs all phases (git, lint, sync, build, test), auto-fixes safe items, and surfaces destructive action candidates (stale branches, orphan worktrees) for your confirmation. Uses a mechanical worker profile.

Use at the **start of every session** — it handles the most common maintenance in one pass.

Example output:

```
## Housekeeping Report

git:   PASS  (main, up to date with origin)
lint:  WARN  (2 files formatted automatically)
sync:  PASS  (all submodules clean)
build: PASS  (js: ok)
test:  PASS  (342 passed, 0 failed)

### Auto-fixed
- 2 files reformatted (moon fmt)
- 1 .mbti file regenerated (moon info)

### Cleanup candidates

| Type   | Name              | Reason                        | Last commit  |
|--------|-------------------|-------------------------------|--------------|
| branch | feature/old-thing | merged into main              | 2026-03-01   |
| branch | wip/stale-idea    | stale (no activity, no PR)    | 2026-02-10   |

Clean up these branches/worktrees? [y/N]
```

---

### `moonbit-housekeeping check` - read-only health check

Quick sanity check. Answers: **"is my repo in a clean state right now?"**

Checks git state, submodules, and lint. No modifications; read-only. Uses a mechanical worker profile.

Use when you just want a **quick glance** without touching anything.

Example output:

```
## Housekeeping Report (check)

git:   PASS  (main, up to date with origin)
lint:  WARN  (2 files need formatting)
sync:  PASS  (all submodules clean)
```

> Run `moonbit-housekeeping` to auto-fix 2 items.

---

### `moonbit-housekeeping fix` - full check + auto-fix only

Runs all phases and applies safe fixes, but does **not** prompt for destructive actions (branch/worktree cleanup). Use when you want auto-fix without the cleanup prompts.

Safe fixes applied automatically:

- `moon fmt` — reformat .mbt files
- `moon info` — regenerate .mbti interface files
- `moon test --update` — update test snapshots

Use at the **end of a long session** before committing. Uses a mechanical worker profile.

---

### `moonbit-housekeeping triage` - project direction

Answers: **"what should I work on next?"**

Reads `docs/TODO.md`, active plans, GitHub issues, and stale branches. Produces:

- Classified TODO items (done / active / blocked / stale / needs-human-review)
- Orphaned plans not referenced from TODO.md
- Stale branch and worktree candidates (with confirmation before pruning)
- Top 3 recommended next actions

Updates `docs/decisions-needed.md` with items needing a decision.

Use **weekly** or when returning after a break and feeling unsure what to tackle. Uses a review worker profile.

---

### `moonbit-housekeeping release` - pre-release prep

Answers: **"is this ready to ship?"**

Runs three checks:

- **changelog** — drafts user-facing changelog from git log, suggests semantic version bump
- **api-review** — classifies `.mbti` changes as intentional / accidental / needs-review, flags breaking changes
- **doc-drift** — checks dev docs, READMEs, and active plans for stale file paths and symbol references

Use **before tagging a release or opening a major PR**. Uses review worker profiles for changelog, API review, and doc drift.

---

## Understanding the Output

### Status levels

- **PASS** — no issues found
- **WARN** — non-blocking (formatting needed, stale branch, dirty submodule)
- **FAIL** — blocking (test failure, build error, lint error)

### Auto-fix vs. destructive actions

The default command draws a clear line:

- **Auto-fixed** (no confirmation): formatting, interface regeneration, snapshot updates — safe, deterministic, reversible
- **Destructive candidates** (asks first): branch deletion, worktree removal — shown in a table, require your [y/N] confirmation

The skill never commits, pushes, or deletes anything without confirmation.

### Confidence levels (triage + release)

- **high** — strong evidence, safe to act on
- **medium** — reasonable evidence, verify before acting
- **low** — mixed signals, human review needed

Items with `confidence: low` or `needs-human-review` are flagged explicitly.

---

## Execution Profiles

| Mode | Worker profile | Notes |
|---|---|---|
| `moonbit-housekeeping` | mechanical worker | Full audit, safe fixes, cleanup candidates |
| `moonbit-housekeeping check` | mechanical worker | Fast read-only report |
| `moonbit-housekeeping fix` | mechanical worker | Safe fixes only |
| `moonbit-housekeeping triage` | review worker | Backlog, branches, next actions |
| `moonbit-housekeeping release` | review workers | Changelog, API review, doc drift |
