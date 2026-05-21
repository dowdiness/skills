#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_BASE="${HOME}/.local/share/dowdiness-skills-backup"
DRY_RUN=true
RESTORE_DIR=""
CHECK_ONLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      DRY_RUN=false
      shift
      ;;
    --restore)
      DRY_RUN=false
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: --restore requires a backup directory argument." >&2
        exit 1
      fi
      RESTORE_DIR="$1"
      shift
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: cleanup-duplicate-skills.sh [--check] [--apply] [--restore <path>] [--help]

Defaults to dry-run to avoid destructive changes.
  --check         Scan and report duplicates without applying or moving anything.
  --apply         Move confirmed duplicate skill paths to a timestamped backup directory.
  --restore <path> Restore backed-up paths from <path>.
EOF
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$RESTORE_DIR" ] && [ ! -d "$RESTORE_DIR" ]; then
  echo "ERROR: restore directory not found: $RESTORE_DIR" >&2
  exit 1
fi

restore_backup() {
  local backup_dir="$1"
  local restored=0
  local skipped=0

  while IFS= read -r -d '' skill_file; do
    local skill_dir
    local rel_dir
    local target
    local base_dir
    local parent_dir

    skill_dir="$(dirname "$skill_file")"
    rel_dir="${skill_dir#$backup_dir/}"
    target="$HOME/$rel_dir"
    base_dir="$(basename "$skill_dir")"
    parent_dir="$(dirname "$target")"

    if [ -e "$target" ]; then
      echo "BLOCKED restore: existing destination exists: $target" >&2
      skipped=$((skipped + 1))
      continue
    fi

    mkdir -p "$parent_dir"
    mv "$skill_dir" "$target"
    echo "RESTORED $skill_dir -> $target"
    restored=$((restored + 1))
  done < <(find "$backup_dir" -type f -name SKILL.md -print0)

  if [ "$skipped" -gt 0 ]; then
    echo "Restore completed with $skipped conflict(s)." >&2
    echo "Kept moved items for conflicted paths in $backup_dir." >&2
    return 1
  fi

  if [ "$restored" -eq 0 ]; then
    echo "No files restored."
  else
    echo "Restored $restored path(s) from: $backup_dir"
  fi
}

if [ -n "$RESTORE_DIR" ]; then
  restore_backup "$RESTORE_DIR"
  exit $?
fi

SKILLS_DIR="$REPO_DIR/skills"
SKILL_NAMES=()

for skill_dir in "$SKILLS_DIR"/*; do
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || continue
  SKILL_NAMES+=("$(basename "$skill_dir")")
done

is_expected_skill() {
  local name="$1"
  for expected in "${SKILL_NAMES[@]}"; do
    if [ "$name" = "$expected" ]; then
      return 0
    fi
  done
  return 1
}

is_repo_link() {
  local path="$1"
  local expected_source="$2"
  [ -L "$path" ] || return 1
  local resolved
  resolved="$(readlink -f "$path" 2>/dev/null || true)"
  [ "$resolved" = "$expected_source" ]
}

TARGET_DIRS=(
  "$HOME/.agents/skills"
  "$HOME/.claude/skills"
  "$HOME/.codex/skills"
)

duplicates=()

for target_dir in "${TARGET_DIRS[@]}"; do
  [ -d "$target_dir" ] || continue
  for entry in "$target_dir"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    is_expected_skill "$name" || continue

    expected_source="$SKILLS_DIR/$name"
    if [ -L "$entry" ]; then
      if is_repo_link "$entry" "$expected_source"; then
        echo "KEEP  $entry"
      else
        duplicates+=("$entry")
      fi
    else
      duplicates+=("$entry")
    fi
  done
done

if [ "${#duplicates[@]}" -eq 0 ]; then
  echo "No duplicate skill paths found."
  exit 0
fi

echo
echo "Duplicate skill paths:"
for item in "${duplicates[@]}"; do
  echo " - $item"
done

if [ "$CHECK_ONLY" = true ]; then
  echo
  if [ "${#duplicates[@]}" -eq 0 ]; then
    echo "Check passed: no duplicate skill paths found."
    exit 0
  fi
  echo "Check failed: ${#duplicates[@]} duplicate path(s) found."
  exit 1
fi

if [ "$DRY_RUN" = true ]; then
  echo
  echo "Dry run complete. Re-run with --apply to backup these entries."
  exit 0
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
if ! mkdir -p "$BACKUP_BASE" 2>/dev/null; then
  BACKUP_BASE="/tmp/dowdiness-skills-backup"
fi
if ! mkdir -p "$BACKUP_BASE" 2>/dev/null; then
  echo "ERROR: unable to create backup directory at $BACKUP_BASE" >&2
  echo "Please provide a writable path." >&2
  exit 1
fi

BACKUP_DIR="$BACKUP_BASE/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

for item in "${duplicates[@]}"; do
  source_parent="$(dirname "$item")"
  source_parent_rel="${source_parent#$HOME/}"
  base="$(basename "$item")"
  mkdir -p "$BACKUP_DIR/$source_parent_rel"
  mv "$item" "$BACKUP_DIR/$source_parent_rel/$base"
  echo "MOVED $item -> $BACKUP_DIR/$source_parent_rel/$base"
done

echo
echo "Backed up ${#duplicates[@]} path(s) to: $BACKUP_DIR"
