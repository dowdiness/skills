#!/usr/bin/env nu

def print-usage [] {
  print "Usage: cleanup-duplicate-skills.nu [--check] [--apply] [--restore <path>] [--help]

Defaults to dry-run to avoid destructive changes.
  --check              Scan and report duplicates without applying or moving anything.
  --apply              Move confirmed duplicate skill paths to a timestamped backup directory.
  --restore <path>     Restore backed-up paths from <path>."
}

def is-symlink [path: string]: nothing -> bool {
  (try { $path | path type } catch { "" }) == "symlink"
}

def resolved-target [link: string]: nothing -> string {
  try { ^readlink -f $link | str trim } catch { "" }
}

def restore-backup [backup_dir_in: string]: nothing -> int {
  mut restored = 0
  mut skipped = 0
  let backup_dir = ($backup_dir_in | path expand)
  let skill_files = (glob $"($backup_dir)/**/SKILL.md")

  for skill_file in $skill_files {
    let skill_dir = ($skill_file | path dirname)
    let prefix = $"($backup_dir)/"
    let rel_dir = ($skill_dir | str substring ($prefix | str length)..)
    let target = ($env.HOME | path join $rel_dir)
    let parent_dir = ($target | path dirname)

    if ($target | path exists) {
      print -e $"BLOCKED restore: existing destination exists: ($target)"
      $skipped = $skipped + 1
      continue
    }

    mkdir $parent_dir
    mv $skill_dir $target
    print $"RESTORED ($skill_dir) -> ($target)"
    $restored = $restored + 1
  }

  if $skipped > 0 {
    print -e $"Restore completed with ($skipped) conflict\(s\)."
    print -e $"Kept moved items for conflicted paths in ($backup_dir)."
    return 1
  }

  if $restored == 0 {
    print "No files restored."
  } else {
    print $"Restored ($restored) path\(s\) from: ($backup_dir)"
  }
  0
}

def main [--apply, --restore: string = "", --check, --help] {
  if $help { print-usage; return }

  let repo_dir = ($env.FILE_PWD | path dirname | path expand)
  let backup_base = ($env.HOME | path join ".local/share/dowdiness-skills-backup")

  if $restore != "" {
    if not ($restore | path exists) {
      print -e $"ERROR: restore directory not found: ($restore)"
      exit 1
    }
    let code = (restore-backup $restore)
    exit $code
  }

  let skills_dir = ($repo_dir | path join "skills")
  let skill_names = (
    ls $skills_dir
    | where type == "dir"
    | where { |row| ($row.name | path join "SKILL.md" | path exists) }
    | each { |row| $row.name | path basename }
  )

  let target_dirs = [
    ($env.HOME | path join ".agents/skills")
    ($env.HOME | path join ".claude/skills")
    ($env.HOME | path join ".codex/skills")
  ]

  mut duplicates: list<string> = []

  for target_dir in $target_dirs {
    if not ($target_dir | path exists) { continue }
    for entry in (ls $target_dir) {
      let path = $entry.name
      let name = ($path | path basename)
      if not ($name in $skill_names) { continue }
      let expected = ($skills_dir | path join $name)
      if (is-symlink $path) and ((resolved-target $path) == $expected) {
        print $"KEEP  ($path)"
      } else {
        $duplicates = ($duplicates | append $path)
      }
    }
  }

  if ($duplicates | is-empty) {
    print "No duplicate skill paths found."
    return
  }

  print ""
  print "Duplicate skill paths:"
  for item in $duplicates {
    print $" - ($item)"
  }

  if $check {
    print ""
    print $"Check failed: ($duplicates | length) duplicate path\(s\) found."
    exit 1
  }

  if not $apply {
    print ""
    print "Dry run complete. Re-run with --apply to backup these entries."
    return
  }

  let real_base = if (try { mkdir $backup_base; true } catch { false }) {
    $backup_base
  } else {
    let fb = "/tmp/dowdiness-skills-backup"
    try { mkdir $fb } catch {
      print -e $"ERROR: unable to create backup directory at ($fb)"
      print -e "Please provide a writable path."
      exit 1
    }
    $fb
  }
  let stamp = (date now | format date "%Y%m%d-%H%M%S")
  let backup_dir = ($real_base | path join $stamp)
  mkdir $backup_dir

  let home_prefix = $"($env.HOME)/"
  for item in $duplicates {
    let source_parent = ($item | path dirname)
    let rel = if ($source_parent | str starts-with $home_prefix) {
      $source_parent | str substring ($home_prefix | str length)..
    } else {
      $source_parent | str replace --all "/" "__"
    }
    let base = ($item | path basename)
    let target_parent = ($backup_dir | path join $rel)
    mkdir $target_parent
    mv $item ($target_parent | path join $base)
    print $"MOVED ($item) -> ($target_parent)/($base)"
  }

  print ""
  print $"Backed up ($duplicates | length) path\(s\) to: ($backup_dir)"
}
