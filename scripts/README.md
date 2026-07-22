# Scripts

Helper scripts for validation, local installation, cleanup, and vendor sync.

## Validate

```bash
npm run validate
npm run validate-agent-models
```

`validate` checks:
- Each skill in `skills/` has `SKILL.md` with matching frontmatter `name` and `description`.
- Each extension in `extensions/` has a default export function.
- Each packaged agent in `agents/` has valid `name` and `description` frontmatter.
- Every directory in `skills/` and `extensions/` is listed in `meta.ts`, and vice versa.
- Vendored skills and extensions show no drift from their submodule sources.

`validate-agent-models` reads every agent's `model` and comma-separated
`fallbackModels`, compares them with the live `pi --list-models` inventory, and
accepts Pi thinking-level suffixes such as `:high`.

`validate-agent-prompts` checks the stable shape of all 16 packaged agent
prompts. It is a static contract check, not a behavioral model evaluation; it
makes no model calls and does not inspect credentials.

## Opt-in agent usage reporting

`agent-usage-report` is a read-only, opt-in summarizer. It accepts only explicit
JSONL files or directories and never scans the home directory:

```bash
npm run agent-usage-report -- --format table ./path/to/explicit-sessions
npm run agent-usage-report -- --format json ./path/to/session.jsonl
npm run agent-usage-report -- --help
```

Reports contain only allowlisted agent names, invocation/runtime counts,
currently configured agent primary and fallback model IDs, non-negative
safe-integer usage totals, explicit leaf durations, and matched tool-call wall
time counted once as `callDurationMs`. Model values are normalized and must
pass the conservative syntax check and match the repository agent frontmatter;
unknown or historical values are redacted and counted rather than retained.
The configured set is read locally and no live model inventory or model call is
made. Automatic report summaries label the observed cohort count as `sessions=`;
legacy file baselines are not presented as session observations.
Missing requested leaves remain unresolved evidence (`missingLeaves` and
`runtime.unresolved`); they are not confirmed invocations or runtime failures.
Task text, cwd, content, messages, responses, credentials, paths, and filenames
are omitted. Each explicit file is correlated independently before aggregate-only
reports are merged. Processing is bounded to 4096 JSONL files, directory depth 16, and
67108864 bytes (64 MiB) per file; symlinks are not followed. Explicit regular
file inputs must use the `.jsonl` extension; non-JSONL files are rejected. Human delegation outcomes
are not merged into runtime success or failure. Keep real session data out of the
repository; the checked-in fixtures are synthetic only. Live model evaluations
remain a separately budgeted, provider-approved future facility.

## Private agent observation cohort

The observation workflow measures aggregate runtime evidence and records small, structured human incidents. Start a cohort once, then use pi normally—no `/new`, shell command, or special prompt is required:

```bash
npm run agent-observation -- start
# use pi normally; checkpoints happen automatically
npm run agent-observation -- status
npm run agent-observation -- report
npm run agent-observation -- finish
```

The packaged `agent-observation` extension checkpoints startup/reload/new/resume/fork/clone,
tree navigation, settled turns, and shutdown. It never finishes a cohort. A user
may say `観測に記録して`; only then does the agent call `record_observation`.
The tool validates the snapshotted agent, strict category/severity, and bounded
note, and returns only an opaque case ID and category. Use `saveToMemory=true`
only when the user explicitly asks to both record and remember the feedback; it
creates a correlated sanitized Markdown memory under
`~/.Codex/skills/agent-memory/memories/agent-observations/`. The combined write
uses best-effort rollback on ordinary failure; cross-directory crash consistency
cannot be made fully atomic.

`start` requires a clean Git worktree and creates a private cohort under
`$XDG_STATE_HOME/skills-agent-observation/<short-head>` (or
`~/.local/state/skills-agent-observation/<short-head>`). It stores the full
commit and UTC start time, hashes of existing normalized absolute JSONL paths,
a sorted snapshot of packaged agent names and normalized configured model IDs,
an empty incident store, and an active pointer; it does not read or copy
session content. Every operation takes an exclusive lock; existing locks fail
closed and are never removed automatically. State and cohort directories are
0700; private files are 0600. Automatic state is one atomic aggregate-plus-
fingerprint checkpoint file and a separate private random HMAC key. It stores
only HMACs, safe aggregate numbers, trusted model snapshots, commit, and times:
never raw entries, messages, responses, task text, cwd, paths, filenames, session
IDs, tool arguments, or notes in that automatic state. The first activation of a
session observes its in-memory entries, counts only globally unseen post-start
invocations, and excludes pre-start or copied history; later activations recover
unseen entries. A valid legacy aggregate is migrated without recounting the
current session. Fork/clone copied history is baselined as a new HMAC session
identity. Quit checkpoints and leaves the cohort active.

`report` and `status` prefer the automatic aggregate once it exists. Existing
cohorts migrate on the next normal pi lifecycle checkpoint; a valid legacy
`latest-report.json` aggregate is retained without double-counting the current
session, and the legacy path remains available until automatic state is present. Before automatic activation they
retain the legacy explicit path-based reporter and its immutable file baseline
behavior. `finish` remains an explicit compatibility command: it records `finishedAt`, removes activation, and safely resumes an
interrupted finish. The active pointer ties report/status/incident to the start
snapshot even if Git HEAD later changes. Valid categories are
`false_clarification`, `false_stop`, `unsafe_proceed`, `wrong_route`,
`false_complete`, `rework`, and `good_assumption`.

Keep the state directory private and out of commits; it is intentionally not
tracked or committed. Review the first 30–50 invocations for a useful signal,
and treat that as a review threshold rather than a statistical guarantee. The
current reporter measures runtime evidence only and cannot automatically judge
semantic answer quality.

## Check the installed Pi agent environment

```bash
npm run check-agent-env
npm --silent run check-agent-env -- --json
```

This read-only diagnostic verifies the pinned package checkout, package-managed
agent links, scheduler/subagent extension filters, development-only extension
overrides, configured model IDs, and a zero-inference Pi startup. It never
repairs, deletes, installs, or updates resources; unavailable model IDs are
reported as `WARN`, inventory/startup failures as `FAIL`, and any `FAIL` exits
1.

## Scheduler profiles

The packaged `extensions/scheduler/` extension selects a profile from repository markers. Canopy markers enable the Canopy profile; all other repositories use the generic profile and remain disabled until `/scheduler on` is issued.

Profile selection checks `.scheduler.json` or `scheduler.config.json` first (`{"profile":"generic"}` or `{"profile":"canopy"}`), then repository markers, and finally uses the generic fallback.

## Install / Uninstall / Cleanup (local symlink)

Symlink this checkout's skills, agent definitions, and extensions into the agent auto-discovery directories (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/agents`, `~/.pi/agent/extensions`).

```bash
npm run install-local                # skip correct links, block conflicts
npm run install-local -- --repair    # back up conflicts, then link
npm run uninstall-local              # remove only symlinks pointing into this repo
```

When duplicates exist outside this repo (e.g. a stale copy in `~/.agents/skills` that is not a symlink to this checkout), use the cleanup helper:

```bash
nu scripts/cleanup-duplicate-skills.nu             # dry run
nu scripts/cleanup-duplicate-skills.nu --check     # report without changes
nu scripts/cleanup-duplicate-skills.nu --apply     # back up duplicates to ~/.local/share/dowdiness-skills-backup/
nu scripts/cleanup-duplicate-skills.nu --restore <backup-dir>
```

## Pi package migration note

The preferred install path is now the pi package (`pi install git:github.com/dowdiness/skills`), which places resources under `~/.pi/agent/`. Local symlink installation targets the older agent discovery directories. If you switch from local symlinks to the pi package, run `npm run uninstall-local` first so that `pi install` does not encounter conflicts.

## Pi package install helper

```bash
npm run install-pi-package
```

Runs `pi install git:github.com/dowdiness/skills` without duplicate resource warnings:

1. backs up local skills, agent definitions, and extensions that would collide,
2. installs or updates the pi package,
3. disables this package's pi skill resources in `settings.json`, and
4. recreates skill compatibility symlinks and `~/.pi/agent/agents` links to the installed package.

The plain `pi install` command installs the package's declared skills and
extensions, but agent definitions are installed by this helper because pi
packages do not declare an `agents` resource directory. Run this helper before
using `parallel-review`.

That keeps package-managed extensions active while preserving compatibility with hosts that still discover skills from `~/.agents/skills`. Backups go to `~/.pi/agent/dowdiness-skills-local-backup-<timestamp>/`.

Options:

```bash
node scripts/install-pi-package.mjs --dry-run                         # show what would be backed up
node scripts/install-pi-package.mjs --no-install                      # back up/link only; skip pi install
node scripts/install-pi-package.mjs --agents-only --no-install        # only migrate/link package-managed agents
node scripts/install-pi-package.mjs --extensions-only                # only migrate extensions and install/update the package
node scripts/install-pi-package.mjs --keep-package-skills            # do not filter package skills or create compatibility symlinks
node scripts/install-pi-package.mjs git:github.com/dowdiness/skills --ref <commit-or-tag>
```

`--agents-only` and `--extensions-only` are mutually exclusive. Agents-only
never touches skills, package skill settings, or extensions. Extensions-only
never touches skills, agents, or package skill settings. `--ref` composes a git
pin as `git:...@<ref>` and rejects already-pinned or local-path sources.

### Reproducible fresh-machine sequence

Pin the checkout, package source, and submodules to the same audited commit:

```bash
SKILLS_SHA='<commit SHA>'
git clone https://github.com/dowdiness/skills.git
cd skills
git checkout "$SKILLS_SHA"
git submodule update --init

node scripts/install-pi-package.mjs git:github.com/dowdiness/skills --ref "$SKILLS_SHA" --extensions-only
node scripts/install-pi-package.mjs git:github.com/dowdiness/skills --ref "$SKILLS_SHA" --agents-only --no-install
```

Before running `validate-agent-models`, configure or log in to every provider used by the selected agent models. The command intentionally reports models from unconfigured providers as unavailable; successful agent/extension installation does not itself supply provider credentials.

```bash
npm run validate-agent-models
pi --offline --no-session --no-tools -p "respond ok"
```

The local absolute-path extension override form is for development only; do
not use it for reproducible deployment.

## Sync vendor content

Check whether vendored skills or extensions have drifted from their submodule sources:

```bash
npm run sync-status                  # skills only, dry run
npm run sync-extensions-status       # extensions only, dry run
```

Apply the sync (copy from submodule source into `skills/` or `extensions/` and record the upstream SHA):

```bash
npm run sync-vendor                  # skills
npm run sync-vendor-extensions       # extensions
```

You can also sync a single vendor entry by name:

```bash
node scripts/sync-vendor-skills.mjs moonbit-agent-guide
```

## List skills

```bash
npm run list
```

Prints each skill and extension with its description (from SKILL.md frontmatter or extension metadata).
