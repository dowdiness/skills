#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

link_skills() {
  local target_dir="$1"
  mkdir -p "$target_dir"
  for skill_dir in "$REPO_DIR"/skills/*; do
    [ -f "$skill_dir/SKILL.md" ] || continue
    local name
    name="$(basename "$skill_dir")"
    remove_repo_link "$target_dir/$name"
    ln -sfn "$skill_dir" "$target_dir/$name"
    echo "Linked: $target_dir/$name"
  done
}

link_skills "$HOME/.agents/skills"
link_skills "$HOME/.claude/skills"
