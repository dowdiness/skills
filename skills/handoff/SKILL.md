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

**Do not update memory for uncommitted work.** Memory should record committed reality, not in-progress intent. If there's uncommitted code, ask the user before proceeding.

### Step 2: Identify memories that need refreshing

The memory directory is `~/.claude/projects/<project-slug>/memory/`. Read `MEMORY.md` for the index.

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

### Step 4: Pick the next investigation target

If the user gave a hint in the invocation, use it. Otherwise:

- Check the project's `docs/todo.md` (or equivalent) for explicit "next" markers
- Check memories tagged "next priorities" / "queued" / "investigation queue"
- Look at what the just-shipped work surfaced (cost-decomposition docs often name the next target)

If multiple candidates exist, present 2–3 with one-line tradeoff each and ask the user to pick. Don't fabricate a recommendation when the evidence is balanced.

If `--no-next` was passed, skip to Step 6.

### Step 5: Draft the next-session prompt

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

### Step 6: Report clearance status

Classify the *current* conversation's content as Required / Optional / Redundant / Compressible. The user needs to know what would be lost on clear.

- **Required (lost on clear, must keep in conversation OR persist elsewhere first):** anything not yet in git, memory, or the drafted next-prompt
- **Optional:** intermediate tool outputs already acted on
- **Redundant:** repeated status checks, system-reminders, schema dumps
- **Compressible:** long investigations whose conclusion is now in a doc

End with an explicit recommendation: "Safe to clear" or "Hold off — <X> is not yet persisted".

## Outputs

- Updated memory files (in place, with `[[link]]` cross-refs preserved)
- Updated `MEMORY.md` index lines for any description changes
- A paste-ready next-session prompt printed in the conversation
- A clearance-readiness verdict

## Guardrails

- **Never invent next steps the user hasn't endorsed.** If multiple targets are plausible, list them and ask. Pinning the wrong next-target in memory misleads the next session more than leaving it unpinned.
- **Never update memory based on uncommitted code.** Memory records reality, and uncommitted work isn't reality yet — it can still be reverted, redirected, or abandoned. Ask first.
- **Never delete memories that record judgment** ("we picked X over Y because Z"). Even after the work ships, the *why* is load-bearing for revisits.
- **Never claim "safe to clear" without verifying the next-prompt's citations resolve.** A broken next-prompt is worse than a verbose conversation, because the user will paste it into a fresh session and hit a wall.
- **Convert relative dates to absolute** in any memory edits or the next-prompt ("Thursday" → "2026-05-22"). Memories outlive their writing context.
