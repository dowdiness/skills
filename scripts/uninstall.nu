#!/usr/bin/env nu

def is-symlink [path: string]: nothing -> bool {
  (try { $path | path type } catch { "" }) == "symlink"
}

def remove-repo-links [target_dir: string, repo_dir: string] {
  if not ($target_dir | path exists) { return }
  for entry in (ls $target_dir) {
    let path = $entry.name
    if not (is-symlink $path) { continue }
    let resolved = (try { ^readlink -f $path | str trim } catch { "" })
    if ($resolved | str starts-with $"($repo_dir)/") {
      rm $path
      print $"Removed: ($path)"
    }
  }
}

def main [] {
  let repo_dir = ($env.FILE_PWD | path dirname | path expand)
  for d in [".agents/skills" ".claude/skills" ".codex/skills"] {
    remove-repo-links ($env.HOME | path join $d) $repo_dir
  }
}
