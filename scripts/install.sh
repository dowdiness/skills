#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR=false
CONFLICTS=()
BACKUP_BASE="${HOME}/.local/share/dowdiness-skills-backup"
BACKUP_DIR=""

usage() {
  cat <<'EOF'
Usage: install.sh [--repair] [--help]

Default mode:
  - skip already-correct links
  - block non-link conflicts so nothing is removed

--repair:
  - moves conflicting existing paths to backup first
  - creates the canonical skill symlinks in-place

Examples:
  ./scripts/install.sh
  ./scripts/install.sh --repair
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repair)
      REPAIR=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

init_backup_dir() {
  if [ -n "$BACKUP_DIR" ]; then
    return
  fi

  if ! mkdir -p "$BACKUP_BASE" 2>/dev/null; then
    BACKUP_BASE="/tmp/dowdiness-skills-backup"
  fi

  if ! mkdir -p "$BACKUP_BASE" 2>/dev/null; then
    echo "ERROR: unable to create backup directory at $BACKUP_BASE" >&2
    exit 1
  fi

  BACKUP_DIR="$BACKUP_BASE/$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$BACKUP_DIR"
  echo "Repair mode enabled. Duplicate entries will be backed up to: $BACKUP_DIR"
}

backup_conflict() {
  local target="$1"
  local parent_dir=""
  local backup_parent=""
  local base_name=""

  parent_dir="$(dirname "$target")"
  base_name="$(basename "$target")"

  if [[ "$parent_dir" == "$HOME"/* ]]; then
    backup_parent="$BACKUP_DIR/${parent_dir#$HOME/}"
  else
    backup_parent="$BACKUP_DIR/extra$(printf '%s' "$parent_dir" | tr '/' '__')"
  fi

  if ! mkdir -p "$backup_parent"; then
    echo "ERROR: unable to create backup directory: $backup_parent" >&2
    return 1
  fi

  if ! mv "$target" "$backup_parent/$base_name"; then
    echo "ERROR: unable to move $target to backup directory" >&2
    return 1
  fi

  echo "Backed up duplicate: $target -> $backup_parent/$base_name"
  return 0
}

remove_repo_link() {
  local link="$1"
  [ -L "$link" ] || return 0
  local resolved=""
  resolved="$(readlink -f "$link" 2>/dev/null || true)"
  case "$resolved" in
    "$REPO_DIR"/*)
      rm "$link"
      echo "Removed stale link: $link"
      ;;
  esac
}

same_repo_link() {
  local link="$1"
  local source="$2"

  [ -L "$link" ] || return 1
  local resolved=""
  resolved="$(readlink -f "$link" 2>/dev/null || true)"
  [ "$resolved" = "$source" ]
}

link_or_skip() {
  local source="$1"
  local link="$2"

  if same_repo_link "$link" "$source"; then
    echo "Already linked: $link"
    return
  fi

  remove_repo_link "$link"

  if [ -e "$link" ]; then
    if [ "$REPAIR" = true ]; then
      init_backup_dir
      if ! backup_conflict "$link"; then
        echo "ERROR: cannot repair blocked path: $link" >&2
        CONFLICTS+=("$link")
        return 0
      fi
      ln -sfn "$source" "$link"
      echo "Repaired link: $link"
      return
    fi

    echo "ERROR: existing path blocked installation: $link" >&2
    echo "  Expected repo link to: $source" >&2
    CONFLICTS+=("$link")
    return 0
  fi

  ln -sfn "$source" "$link"
  echo "Linked: $link"
}

link_skills() {
  local target_dir="$1"
  mkdir -p "$target_dir"
  for skill_dir in "$REPO_DIR"/skills/*; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    local name
    name="$(basename "$skill_dir")"
    link_or_skip "$skill_dir" "$target_dir/$name"
  done
}

report_conflicts() {
  if [ "${#CONFLICTS[@]}" -eq 0 ]; then
    return 0
  fi

  echo "BLOCKED by ${#CONFLICTS[@]} path(s):" >&2
  printf '  - %s\n' "${CONFLICTS[@]}" >&2
  return 1
}

link_skills "$HOME/.agents/skills"
link_skills "$HOME/.claude/skills"
link_skills "$HOME/.codex/skills"
report_conflicts
