---
name: rivet
description: Open the Rivet editor and create, compare, refine, or apply web design variants when the user asks to use Rivet, including /rivet. General UI work does not require Rivet.
---

# Rivet

Use Rivet for the user's requested design exploration. The operating contract
previously embedded in global `AGENTS.md` now lives in
[references/cli-guidance.md](references/cli-guidance.md). Read it before running
Rivet commands; unrelated tasks do not need this reference.

For a bare `/rivet`, open the current project with the normal browser behavior
and return `editorUrl`. Use explicit project and caller attribution flags from
the reference. Rivet CLI invocations must be plain commands: its host allowlist
requirement is the Rivet-specific exception to the generic RTK wrapper rule.

Preserve the user's provider and fidelity choices. Follow the response's
`nextAction` to distinguish server-owned execution from host-owned work; use
the supplied workspaces and completion commands. Do not cancel active work to
unblock a new request. Apply a variant when the user chooses it.

## Maintaining the reference

The reference is the single local copy of the migrated CLI guidance, with its
original guidance-version marker. Rivet's installer and update path can write
the full managed block back to `~/.codex/AGENTS.md`. When explicitly updating
Rivet, reconcile any new guidance into this reference and restore the short
global skill link; preserve unrelated user instructions. Do not run an update
merely to use this skill.
