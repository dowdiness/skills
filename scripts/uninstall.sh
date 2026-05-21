#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

remove_links() {
  local target_dir="$1"
  [ -d "$target_dir" ] || return 0
  for link in "$target_dir"/*; do
    [ -L "$link" ] || continue
    local resolved
    resolved="$(readlink -f "$link" 2>/dev/null || true)"
    case "$resolved" in
      "$REPO_DIR"/*)
        rm "$link"
        echo "Removed: $link"
        ;;
    esac
  done
}

remove_links "$HOME/.agents/skills"
remove_links "$HOME/.claude/skills"
remove_links "$HOME/.codex/skills"
