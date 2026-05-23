---
name: handoff
description: >
  End-of-session ritual: update memories for completed work, draft a
  self-contained next-session prompt, and report what's safe to drop from
  conversation context. Use when concluding a work session and preparing to
  /clear. Usage: /handoff [next-target-hint]
---

# Handoff

Session-end ritual that produces a clean handoff to the next session and tells you when it's safe to `/clear`. Prevents the failure mode where a session ends with the work done in code but the memory state still reflects yesterday's plan, forcing the next session to re-derive context from git log.

## When to invoke

Trigger when the user signals the session is ending and asks for some combination of: "wrap up", "handoff", "clear context", "what's next", "update memory and propose next prompt", "ready to clear".

**Do not invoke** for conceptual questions about handoffs ("how do you usually wrap up?") — that's a discussion, not an execution.

## Usage

- `/handoff` — full ritual; ask the user for the next target if not obvious from context
- `/handoff <next-target>` — full ritual with the next investigation target specified (e.g., `/handoff disposed-cell anomaly`)
- `/handoff --no-next` — skip the next-prompt step (use when truly wrapping up with nothing queued)

## Execution

### Step 1: Audit what completed this session

Run these in parallel to establish the ground-truth delta from session start:

```bash
git log --oneline @{u}..HEAD 2>/dev/null   # commits ahead of upstream
git log --oneline -5                       # context for recent merges
gh pr list --state merged --limit 5 --search "merged:>=$(date -d '1 day ago' +%Y-%m-%d) author:@me" 2>/dev/null
git status --short                         # uncommitted work
```

Identify:
- What shipped (merged PRs with their squash SHA)
- What was committed but not yet merged
- What was edited but not committed (potential incomplete work — flag for user before memory update)
- **Work outside this repo** (global skills under `~/.claude/skills/`, `~/.claude/CLAUDE.md`, dotfiles, other repos worked in via `git -C`). The in-repo audit will silently miss these. If you cannot recall the session's actual artifact location, scan the conversation for `Edit`/`Write` tool calls and list each modified path explicitly. Out-of-repo work is invisible to git but is the most common audit-blind-spot for sessions that edit Claude's own configuration.

**Do not update memory for uncommitted work.** Memory should record committed reality, not in-progress intent. If there's uncommitted code, ask the user before proceeding.

**Partial mode.** If the session was aborted mid-task or work is materially uncommitted (not just stray formatting), enter partial mode: skip Step 3 entirely, run Steps 4 / 6 / 7 / 8 to capture state, blocker, and a *recovery-shaped* next-prompt that names the uncommitted paths and the resume point. Memory remains untouched until the work lands.

### Step 2: Identify memories that need refreshing

The memory directory is `~/.claude/projects/<project-slug>/memory/`. Read `MEMORY.md` for the index.

**No-op is a legitimate outcome.** If the session's work was on global artifacts (skills, CLAUDE.md, dotfiles) rather than any project's content, no project memory will reference it and there will be nothing to refresh. Note "no memories needed refreshing — work was out-of-project" in your retrospective and proceed to Step 4. Do not invent edits to justify the step.

**Audit the index AND the bodies — they drift independently.** Stale index lines are a recurring failure mode: a memory's body can be refreshed in one session, but if the one-line index description (which is what the next session sees first) wasn't touched, that next session reads a lie. Always re-grep the index for status-keyword phrases that may have moved on:

```bash
grep -E 'next investigation|chosen direction|queued|in progress|investigating' \
  ~/.claude/projects/<slug>/memory/MEMORY.md
```

Each match is a candidate for re-check — verify against current memory bodies and against committed work.

Memories to consider refreshing (apply to both index and body):
- Any memory whose `name:` slug was referenced via `[[name]]` in this session
- Any memory whose body cites a file the session modified
- Any memory tagged with a date stale by >2 weeks (the harness flags these with a "this memory is N days old" reminder)
- Any memory with status keywords (above) that may have moved to "shipped" / "closed" / "deprioritized"
- Any memory whose index line names a "next" or "queued" item that other memories now mark as done

For each candidate, read it and decide: refresh, archive, or leave. **After editing a memory body, always re-read the corresponding MEMORY.md index line to confirm it still tells the truth.**

### Step 3: Update memory files

Edit memories in place. For shipped items, the common edits are:
- **Description field:** add merge SHA, change "chosen/queued" → "SHIPPED" or "MERGED"
- **Status note in body:** add a `**Shipped YYYY-MM-DD as PR #N (commit SHA)**` line near the top
- **Corrected claims:** if the session revealed earlier estimates were wrong (e.g., "~80–150 ns/r" turned into actual ~46 ns/r), correct the memory, don't just add a footnote
- **Reference points:** update file:line citations if files moved

Also update the `MEMORY.md` index lines for any memory whose one-line description changed. The index is what the next session sees first — out-of-date index lines mislead.

**Do not delete memories that record decisions.** A shipped optimization's "why we picked lazy-alloc not pool" is load-bearing even after the work merges; future sessions revisiting the area need that judgment record.

### Step 4: Retrospective — rate the session, extract lessons

This step exists to convert this session's *experience* into artifacts the next session can use. Skipping it is the failure mode where the same mistake recurs because the lesson lived only in conversation context — and conversation context dies at `/clear`.

**Scope discipline.** For a small session (one bug fix, <50 lines, no surprises), the retrospective is 2–3 lines total and Step 5 is usually a no-op. Do not bloat short sessions with ceremony. The detailed rubric below applies to sessions that produced new judgment, hit surprises, or used multiple skills.

**On re-run within the same session** (first /handoff exposed a gap → patched → re-ran), diff against the previous retrospective and record only the deltas; don't re-state lessons already captured.

**Rate the session** along these axes. One-line verdict + one-line reason each. Verdicts are `good / acceptable / poor / N/A`, not numeric — numbers invite false precision.

- **Outcome**: did the session deliver its primary objective?
- **Process fit (incl. rework cycles)**: did the workflow match task size? (over-engineered ceremony is just as much a miss as under-engineered cowboy work — cf. CLAUDE.md "Process Calibration") A single redo cycle is acceptable; ≥2 on the same artifact is signal the design wasn't right before implementation started.
- **Token economy**: was history bloated by avoidable re-reads, loose subagent returns, exploratory tangents? (cf. CLAUDE.md "Session Length Discipline" + `feedback_token_economy`)
- **Decision validation**: were judgment calls validated (Codex consult, brainstorm, AskUser) where the cost of being wrong warranted it?
- **User alignment**: did the agent infer or ask correctly, avoid unwanted work, preserve trust? (A session can ship the code and still fail this axis if the user had to repeatedly redirect or reassert preferences.)
- **Recoverability**: could a fresh session resume from durable artifacts (memory, git, the drafted next-prompt) *alone*, without this conversation? (Failing this axis means the handoff itself is broken even if the work succeeded.)

**Extract lessons.** Scan the session — especially user corrections, surprising tool results, redo cycles, moments where you noticed mid-stream "I should have done X first" — and list each notable observation. For each, classify the destination. **If multiple destinations apply, choose the narrowest scope: project < user < global** (avoids over-promoting one-off lessons into CLAUDE.md or new skills). The same rule picks the *file layer* for settings/CLAUDE.md edits: personal/local → `.local` variant; team-shared → repo-level; cross-project → user-level (`~/.claude/`).

| Destination | When to use |
|-------------|-------------|
| **Existing memory edit** | Refines or contradicts a memory already covered in Step 3. Loop back and amend. |
| **New feedback memory** | A reusable user-preference-shaped insight ("user prefers X over Y because Z") not yet captured. |
| **New project memory** | Load-bearing project context (decision, deadline, stakeholder ask) that survives this work item. |
| **Tooling/config update** | A hook, `settings.json` (user / project / local layer), dotfile, dependency pin, env var, install-script, or MCP/plugin setup gap. These are NOT skill edits — they're environment fixes. Choose the layer matching scope: `~/.claude/settings.json` for cross-project, `.claude/settings.json` for team-shared, `.claude/settings.local.json` for personal/local. Route via `/update-config` or edit directly. |
| **Skill update** | An existing skill (including `/handoff` itself) had a gap, wrong default, or missing guardrail that this session exposed. → carry to Step 5. |
| **New skill candidate** | A *repeated* workflow surfaced that no skill yet covers. Propose a *separate* `writing-skills` session — do not draft the skill inline as a `/handoff` micro-edit. |
| **Superseded decision** | Work made obsolete by mid-session direction change. Record what NOT to continue so the next session doesn't resurrect it. Often pairs with a "Don't conflate with" line in the next-prompt. |
| **CLAUDE.md update** | A behavior-shaping rule. Layer follows scope: `~/.claude/CLAUDE.md` for global cross-project rules, repo `CLAUDE.md` for team-shared conventions, `~/.claude/projects/<slug>/CLAUDE.md` for personal project notes. High bar for global; lower for project-shared. |
| **Discard** | Already covered by existing artifact, or too session-specific to be worth persisting. |

Create the new feedback/project memories in this step (same format as Step 3). Defer skill updates and CLAUDE.md updates to Step 5 — those are durable cross-session changes that need explicit user approval.

### Step 5: Self-improvement check — propose durable workflow edits

For each lesson classified as **Skill update**, **Tooling/config update**, or **CLAUDE.md update** in Step 4, run the following loop. The loop is the same regardless of artifact type — skill, settings layer, or CLAUDE.md layer. This is the mechanism by which `/handoff` improves the broader Claude Code workflow (not just skills) over time.

For each candidate edit:

1. **Name the skill and the gap.** Quote the session moment that exposed it ("when X happened, the skill said nothing / said Y which was wrong / lacked the guardrail that would have prevented Z"). Citing the moment preserves the *why* record — per design principle 8, a skill edit without its motivating evidence rots into folklore.
2. **State the proposed edit concretely.** Prefer small targeted additions (one paragraph, one bullet, one guardrail line) over rewrites. If the skill needs structural surgery, that's a separate `writing-skills` session, not a `/handoff` micro-edit. Quote the exact old text → exact new text.
3. **Get user approval before editing.** Skill files are durable cross-session changes; landing the wrong edit silently shapes future behavior. Present the diff and wait for explicit `yes` / `revise` / `skip`.
4. **Apply approved edits** by artifact type:
   - **Skills:** Edit in place for skills outside this repo (e.g. `~/.claude/skills/<name>/SKILL.md`). Plugin-managed skills (under `~/.claude/plugins/cache/...`) are overwritten on plugin update — do *not* edit there; create a local override in `~/.claude/skills/<name>/` or surface upstream, and tell the user which path you took.
   - **Settings:** Prefer `/update-config` (knows the layer mechanics, validates JSON). Otherwise edit the layer chosen in step 1: `.claude/settings.local.json` (personal), `.claude/settings.json` (project-shared), or `~/.claude/settings.json` (cross-project).
   - **CLAUDE.md:** Edit the layer matching scope — `~/.claude/CLAUDE.md` (global), repo `CLAUDE.md` (project-shared), or `~/.claude/projects/<slug>/CLAUDE.md` (personal project notes).
5. **Log meta-findings.** If the gap was in `/handoff` itself, note it explicitly in your output ("this retrospective exposed a `/handoff` gap that this very pass is patching"). This makes the meta-loop visible and prevents future sessions from re-proposing the same edit because the rationale wasn't recorded.
6. **Edits apply to the next invocation, not this one.** The procedure being executed must not mutate mid-run; freeze the rule-set in force at Step 4 and apply approved edits only on the next `/handoff`.

**When NOT to propose an edit:**

- The "gap" is really a one-off task quirk, not a recurring failure mode. Skills encode patterns, not anecdotes.
- The lesson is project-specific. Use a project memory or CLAUDE.md instead.
- The lesson fits **Tooling/config**, **CLAUDE.md**, or **memory** better than a skill — route it there. "Skill update" is the highest-cruft bucket; explicitly bias against it.
- You're tempted to add a guardrail "just in case" with no evidence it would have helped. Skills accumulate cruft fast; only add what the session *demonstrated* you needed.
- The artifact (skill, setting, or rule) wasn't actually exercised this session. You can't credibly rate it from outside its execution path.

### Step 6: Pick the next investigation target

If the user gave a hint in the invocation, use it. Otherwise:

- Check the project's `docs/todo.md` (or equivalent) for explicit "next" markers
- Check memories tagged "next priorities" / "queued" / "investigation queue"
- Look at what the just-shipped work surfaced (cost-decomposition docs often name the next target)
- If the next target lives in a *different repo*, name the repo path and required checkout state in the prompt's Context section — otherwise the next session fabricates local continuity from the wrong cwd.

If multiple candidates exist, present 2–3 with one-line tradeoff each and ask the user to pick. Don't fabricate a recommendation when the evidence is balanced.

If `--no-next` was passed, skip to Step 8.

### Step 7: Draft the next-session prompt

The prompt must be **self-contained** — readable cold by a fresh session with no conversation context. Structure:

```
<one-sentence goal>

Context (verify before acting):
- <2-4 bullets of established facts from current memory/docs>
- <Include numbers, file:line refs, the size of the problem>

Background:
- See memory: <relevant memory slugs>
- <file:line citations for the key code sites>

Don't conflate with:
- <Recent shipped/concurrent work in adjacent code that could confuse the next
  session — name the PR/SHA and the code area, and what makes it different.
  If genuinely nothing nearby to confuse with, write "N/A — different code area
  from anything recently merged" so the omission is intentional, not accidental.>

First step (per <pinned TODO entry or memory>):
<The smallest concrete action that produces a decision-relevant signal>

Discipline:
- <Relevant skill names: moonbit-perf-investigation, systematic-debugging, etc.>
- <Anti-patterns to avoid based on this session's lessons>
```

The "Don't conflate with" section is a **default field**, not an optional one. Sessions that just shipped work in a related area are the highest risk for context-confusion in the next session — when an LLM re-enters a codebase and sees recent activity in `cells/`, the natural assumption is that the activity is related to the current task. Pre-emptively name the differences.

**Verify the prompt's citations point to artifacts that survive `/clear`**: committed files, merged docs, persisted memories, **and installed skills/slash-commands**. A prompt that cites "the bench output from earlier in this conversation" is broken. For each file:line citation in the draft, grep it before issuing the prompt — file moves and refactors invalidate refs silently. For each `/slash-command` referenced as a step, verify the skill exists (`ls ~/.claude/skills/<name>` or check the session's available-skills list) — CLAUDE.md and prior handoffs sometimes name commands that were never installed, and the next session will dutifully try to invoke them.

**Fold the retrospective's lessons into the prompt's `Discipline` section.** Anti-patterns this session surfaced ("don't conflate cell-disposal cleanup with cell-allocation perf work") belong here — they're the highest-leverage place to spend the next session's context budget, because the next session encounters `Discipline` *before* it starts acting.

### Step 8: Report clearance status

Classify the *current* conversation's content as Required / Optional / Redundant / Compressible. The user needs to know what would be lost on clear.

- **Required (lost on clear, must keep in conversation OR persist elsewhere first):** anything not yet in git, memory, or the drafted next-prompt
- **Optional:** intermediate tool outputs already acted on
- **Redundant:** repeated status checks, system-reminders, schema dumps
- **Compressible:** long investigations whose conclusion is now in a doc

End with an explicit recommendation: "Safe to clear" or "Hold off — <X> is not yet persisted".

## Outputs

- Updated memory files (in place, with `[[link]]` cross-refs preserved)
- Updated `MEMORY.md` index lines for any description changes
- New feedback/project memories created from Step 4 lessons
- A short retrospective block printed in the conversation: rating verdicts (one line each) + lessons table + skill-edit proposals (or "no skill gaps exposed")
- Approved durable edits applied (skill / settings layer / CLAUDE.md), or pending/skipped proposals listed — each with the session-moment citation
- A paste-ready next-session prompt printed in the conversation
- A clearance-readiness verdict

## Guardrails

- **Never invent next steps the user hasn't endorsed.** If multiple targets are plausible, list them and ask. Pinning the wrong next-target in memory misleads the next session more than leaving it unpinned.
- **Never update memory based on uncommitted code.** Memory records reality, and uncommitted work isn't reality yet — it can still be reverted, redirected, or abandoned. Ask first.
- **Never delete memories that record judgment** ("we picked X over Y because Z"). Even after the work ships, the *why* is load-bearing for revisits.
- **Never claim "safe to clear" without verifying the next-prompt's citations resolve.** A broken next-prompt is worse than a verbose conversation, because the user will paste it into a fresh session and hit a wall.
- **Convert relative dates to absolute** in any memory edits or the next-prompt ("Thursday" → "2026-05-22"). Memories outlive their writing context.
- **Never edit a durable workflow artifact (skill, settings layer, or CLAUDE.md) without user approval and a cited session moment.** Silent edits drift behavior in ways the user can't audit later. The session-moment citation is non-negotiable — it's the only thing that lets future-you (or future-user) evaluate whether the edit is still load-bearing or has become cruft.
- **Do not edit plugin-cache skills in place.** Files under `~/.claude/plugins/cache/...` are overwritten on plugin update — your edit will silently vanish. Either create a local override or surface the gap upstream, and tell the user which.
- **Right-size the retrospective.** A two-line bug-fix session does not need the full axis rating. Apply the full rubric only when the session produced new judgment, hit surprises, or used multiple skills. Performative ceremony on trivial work is itself a process-fit miss.
- **Bloat brake on `/handoff` self-edits.** Each self-edit must either *replace* existing text or pair the addition with a deletion/merge candidate cited in the same proposal. Track the net line delta; once three consecutive self-edits have been net-positive, the next `/handoff` self-improvement pass must be a consolidation review (merge overlapping bullets, prune dead guardrails) rather than another addition.
