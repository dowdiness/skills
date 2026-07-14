#!/usr/bin/env nu

def print-usage [] {
  print "Usage: install.nu [--repair] [--help]

Default mode:
  - skip already-correct links
  - block non-link conflicts so nothing is removed

--repair:
  - moves conflicting existing paths to backup first
  - creates the canonical skill symlinks in-place

Examples:
  ./scripts/install.nu
  ./scripts/install.nu --repair"
}

def is-symlink [path: string]: nothing -> bool {
  (try { $path | path type } catch { "" }) == "symlink"
}

def resolved-target [link: string]: nothing -> string {
  try { ^readlink -f $link | str trim } catch { "" }
}

def same-repo-link [link: string, source: string]: nothing -> bool {
  if not (is-symlink $link) { return false }
  (resolved-target $link) == $source
}

def remove-stale-repo-link [link: string, repo_dir: string] {
  if not (is-symlink $link) { return }
  let resolved = (resolved-target $link)
  if ($resolved | str starts-with $"($repo_dir)/") {
    rm $link
    print $"Removed stale link: ($link)"
  }
}

def make-backup-dir []: nothing -> string {
  let primary = ($env.HOME | path join ".local/share/dowdiness-skills-backup")
  let base = if (try { mkdir $primary; true } catch { false }) {
    $primary
  } else {
    let fb = "/tmp/dowdiness-skills-backup"
    try { mkdir $fb } catch {
      print -e $"ERROR: unable to create backup directory at ($fb)"
      exit 1
    }
    $fb
  }
  let stamp = (date now | format date "%Y%m%d-%H%M%S")
  let suffix = (random chars --length 4)
  let dir = ($base | path join $"($stamp)-($suffix)")
  mkdir $dir
  print $"Repair mode enabled. Duplicate entries will be backed up to: ($dir)"
  $dir
}

def backup-conflict [target: string, backup_dir: string]: nothing -> bool {
  let parent = ($target | path dirname)
  let base = ($target | path basename)
  let home_prefix = $"($env.HOME)/"
  let backup_parent = if ($parent | str starts-with $home_prefix) {
    let rel = ($parent | str substring (($home_prefix | str length))..)
    $backup_dir | path join $rel
  } else {
    let mangled = ($parent | str replace --all "/" "__")
    $backup_dir | path join $"extra($mangled)"
  }
  try {
    mkdir $backup_parent
    mv $target ($backup_parent | path join $base)
    print $"Backed up duplicate: ($target) -> ($backup_parent)/($base)"
    true
  } catch { |err|
    print -e $"ERROR: unable to back up ($target): ($err.msg)"
    false
  }
}

# Returns {action: "linked"|"skipped"|"conflict", path, backup_dir}
def link-one [
  source: string,
  link: string,
  repair: bool,
  repo_dir: string,
  backup_dir_in: string,
]: nothing -> record {
  if (same-repo-link $link $source) {
    print $"Already linked: ($link)"
    return {action: "skipped", path: $link, backup_dir: $backup_dir_in}
  }
  remove-stale-repo-link $link $repo_dir

  let occupied = (($link | path exists) or (is-symlink $link))
  if $occupied {
    if $repair {
      let bd = if $backup_dir_in == "" { make-backup-dir } else { $backup_dir_in }
      if (backup-conflict $link $bd) {
        ^ln -sfn $source $link
        print $"Repaired link: ($link)"
        return {action: "linked", path: $link, backup_dir: $bd}
      }
      print -e $"ERROR: cannot repair blocked path: ($link)"
      return {action: "conflict", path: $link, backup_dir: $bd}
    }
    print -e $"ERROR: existing path blocked installation: ($link)"
    print -e $"  Expected repo link to: ($source)"
    return {action: "conflict", path: $link, backup_dir: $backup_dir_in}
  }

  ^ln -sfn $source $link
  print $"Linked: ($link)"
  {action: "linked", path: $link, backup_dir: $backup_dir_in}
}

def main [--repair, --help] {
  if $help { print-usage; return }

  let repo_dir = ($env.FILE_PWD | path dirname | path expand)
  let skills_root = ($repo_dir | path join "skills")
  let extensions_root = ($repo_dir | path join "extensions")
  let agents_root = ($repo_dir | path join "agents")
  let target_dirs = [
    ($env.HOME | path join ".agents/skills")
    ($env.HOME | path join ".claude/skills")
    ($env.HOME | path join ".codex/skills")
  ]
  let extension_target_dirs = [
    ($env.HOME | path join ".pi/agent/extensions")
  ]
  let agent_target_dirs = [
    ($env.HOME | path join ".pi/agent/agents")
  ]

  mut conflicts: list<string> = []
  mut backup_dir: string = ""

  for target_dir in $target_dirs {
    mkdir $target_dir
    let skill_dirs = (
      ls $skills_root
      | where type == "dir"
      | where { |row| ($row.name | path join "SKILL.md" | path exists) }
    )
    for sd in $skill_dirs {
      let name = ($sd.name | path basename)
      let link = ($target_dir | path join $name)
      let result = (link-one $sd.name $link $repair $repo_dir $backup_dir)
      $backup_dir = $result.backup_dir
      if $result.action == "conflict" {
        $conflicts = ($conflicts | append $result.path)
      }
    }
  }

  if ($agents_root | path exists) {
    for target_dir in $agent_target_dirs {
      mkdir $target_dir
      let agent_files = (ls $agents_root | where type == "file" | where name =~ '\.md$')
      for agent in $agent_files {
        let name = ($agent.name | path basename)
        let link = ($target_dir | path join $name)
        let result = (link-one $agent.name $link $repair $repo_dir $backup_dir)
        $backup_dir = $result.backup_dir
        if $result.action == "conflict" {
          $conflicts = ($conflicts | append $result.path)
        }
      }
    }
  }

  if ($extensions_root | path exists) {
    for target_dir in $extension_target_dirs {
      mkdir $target_dir
      let extension_entries = (ls $extensions_root | where name !~ '\.gitkeep$')
      for entry in $extension_entries {
        let name = ($entry.name | path basename)
        let link = ($target_dir | path join $name)

        if $entry.type == "dir" {
          let index_path = ($entry.name | path join "index.ts")
          if not ($index_path | path exists) { continue }
          let result = (link-one $entry.name $link $repair $repo_dir $backup_dir)
          $backup_dir = $result.backup_dir
          if $result.action == "conflict" {
            $conflicts = ($conflicts | append $result.path)
          }
        } else if ($entry.name | str ends-with ".ts") {
          let result = (link-one $entry.name $link $repair $repo_dir $backup_dir)
          $backup_dir = $result.backup_dir
          if $result.action == "conflict" {
            $conflicts = ($conflicts | append $result.path)
          }
        }
      }
    }
  }
  let legacy_extension_names = ["canopy-scheduler" "canopy-scheduler.ts"]
  for target_dir in $extension_target_dirs {
    for name in $legacy_extension_names {
      let link = ($target_dir | path join $name)
      if not (($link | path exists) or (is-symlink $link)) { continue }
      if $repair {
        let bd = if $backup_dir == "" { make-backup-dir } else { $backup_dir }
        if (backup-conflict $link $bd) {
          $backup_dir = $bd
        } else {
          $conflicts = ($conflicts | append $link)
        }
      } else {
        remove-stale-repo-link $link $repo_dir
        if (($link | path exists) or (is-symlink $link)) {
          $conflicts = ($conflicts | append $link)
        }
      }
    }
  }

  if ($conflicts | is-empty) { return }

  print -e $"BLOCKED by ($conflicts | length) path\(s\):"
  for c in $conflicts {
    print -e $"  - ($c)"
  }
  exit 1
}
