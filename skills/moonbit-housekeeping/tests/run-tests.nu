#!/usr/bin/env nu

# run-tests.nu — regression harness for parse-worker-output.py
#
# Fixture format:
#   <name>.txt    — raw stdin input (may be absent for CLI-error fixtures)
#   <name>.expect — first line: "EXIT <N>"
#                   optional second line: "ARGS: <extra-args>" or "ARGS: (none)" or
#                     "ARGS: --input FIXTURE_PATH" (FIXTURE_PATH is substituted with the
#                     absolute path to the .txt file)
#                   remaining lines: expected stdout (empty when EXIT!=0 or for error-only tests)
#
# F fixtures (f1/f2/f3) run concurrently via par-each.

const SEQUENTIAL_FIXTURES = [
  "a1-changelog-clean"
  "a2-apireview-clean"
  "a3-docdrift-clean"
  "b1-changelog-preamble-fence"
  "b2-apireview-midprose"
  "b3-docdrift-multiparagraph"
  "c1-empty"
  "c2-pure-prose"
  "c3-truncated-strict"
  "c4-truncated-allow"
  "c5-japanese-unicode"
  "c6-backticks-in-strings"
  "c7-multi-object"
  "d1-input-flag"
  "d2-invalid-root"
  "d3-missing-root"
  "d4-invalid-schema"
  "e1-extra-fields"
  "e2-trailing-comma"
  "e3-markdown-in-strings"
  "e4-large-50-findings"
  "g1-reviewfindings-clean"
  "g2-reviewfindings-prose-fence"
  "g3-reviewfindings-prose-only"
]

const PARALLEL_FIXTURES = [
  "f1-parallel-changelog"
  "f2-parallel-apireview"
  "f3-parallel-docdrift"
]

def first-diff-line [expected: string, actual: string]: nothing -> string {
  let exp = ($expected | lines)
  let act = ($actual | lines)
  let n = ([($exp | length) ($act | length)] | math max)
  if $n == 0 { return "(both empty)" }
  for i in 0..($n - 1) {
    let e = ($exp | get -o $i | default "")
    let a = ($act | get -o $i | default "")
    if $e != $a {
      return $"line ($i + 1): expected '($e)' got '($a)'"
    }
  }
  "trailing whitespace only"
}

def root-for-name [name: string]: nothing -> string {
  if ($name | str contains "changelog") { "Changelog" } else if ($name | str contains "apireview") { "ApiReview" } else if ($name | str contains "docdrift") { "DocDrift" } else if ($name | str contains "reviewfindings") { "ReviewFindings" } else { "Changelog" }
}

def run-fixture [name: string, tool: string, script_dir: string]: nothing -> record {
  let expect_file = ($script_dir | path join $"($name).expect")
  let txt_file = ($script_dir | path join $"($name).txt")

  if not ($expect_file | path exists) {
    return {name: $name, ok: false, message: $"FAIL ($name): missing .expect file"}
  }

  let expect_lines = (open --raw $expect_file | lines)
  let expected_exit = ($expect_lines | first | str replace "EXIT " "" | into int)

  let has_args = ((($expect_lines | length) >= 2) and (($expect_lines | get 1) | str starts-with "ARGS:"))
  let args_line = if $has_args { ($expect_lines | get 1 | str replace "ARGS: " "") } else { "" }
  let body_start = if $has_args { 2 } else { 1 }
  let expected_stdout = ($expect_lines | skip $body_start | str join "\n")

  mut use_root = true
  mut extra_args: list<string> = []

  if $args_line == "(none)" {
    $use_root = false
  } else if $args_line == "--input FIXTURE_PATH" {
    $extra_args = ["--input" $txt_file]
  } else if $args_line != "" {
    $extra_args = ($args_line | split row " ")
    if ("--root" in $extra_args) {
      $use_root = false
    }
  }

  let cmd_args = if $use_root {
    ["--root" (root-for-name $name)] | append $extra_args
  } else {
    $extra_args
  }

  let use_stdin = (($txt_file | path exists) and ($args_line != "--input FIXTURE_PATH"))

  let result = if $use_stdin {
    open --raw $txt_file | ^$tool ...$cmd_args | complete
  } else {
    "" | ^$tool ...$cmd_args | complete
  }

  let actual_stdout = $result.stdout
  let actual_exit = $result.exit_code

  let norm_expected = ($expected_stdout | str trim --right)
  let norm_actual = ($actual_stdout | str trim --right)

  if $actual_exit != $expected_exit {
    return {name: $name, ok: false, message: $"FAIL ($name): exit code: got ($actual_exit), expected ($expected_exit)"}
  }
  if $norm_actual != $norm_expected {
    let diff = (first-diff-line $norm_expected $norm_actual)
    return {name: $name, ok: false, message: $"FAIL ($name): stdout mismatch \(($diff)\)"}
  }

  {name: $name, ok: true, message: $"PASS ($name)"}
}

def main [] {
  let script_dir = $env.FILE_PWD
  let tool = ($script_dir | path dirname | path join "parse-worker-output.py")

  mut pass = 0
  mut fail = 0

  for name in $SEQUENTIAL_FIXTURES {
    let r = (run-fixture $name $tool $script_dir)
    print $r.message
    if $r.ok { $pass = $pass + 1 } else { $fail = $fail + 1 }
  }

  print "# Running F fixtures concurrently..."
  let parallel_results = ($PARALLEL_FIXTURES | par-each { |n| run-fixture $n $tool $script_dir })
  for r in $parallel_results {
    print $r.message
    if $r.ok { $pass = $pass + 1 } else { $fail = $fail + 1 }
  }

  let total = ($pass + $fail)
  print $"RESULT: ($pass)/($total)"
  if $fail > 0 { exit 1 }
}
