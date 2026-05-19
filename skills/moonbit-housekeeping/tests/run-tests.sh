#!/usr/bin/env bash
# run-tests.sh — regression harness for parse-worker-output.py
#
# FIXTURE FORMAT CONVENTION:
#   <name>.txt    — raw stdin input fed to the tool (may be absent for CLI-error fixtures)
#   <name>.expect — first line: "EXIT <N>"
#                   second line (optional): "ARGS: <extra-args>" or "ARGS: (none)" or
#                     "ARGS: --input FIXTURE_PATH" (special token: FIXTURE_PATH is substituted
#                     with the absolute path to the .txt file)
#                   remaining lines: expected stdout (empty when EXIT!=0, or for error-only tests)
#
# For d3-missing-root: no --root is passed, so the base invocation uses no --root either.
# The ARGS "(none)" token means: strip --root from the default invocation entirely.
#
# F fixtures (f1/f2/f3) run concurrently via background jobs + wait.
# All other fixtures run sequentially.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$(dirname "$SCRIPT_DIR")/parse-worker-output.py"

pass=0
fail=0

run_fixture() {
    local name="$1"
    local expect_file="$SCRIPT_DIR/${name}.expect"
    local txt_file="$SCRIPT_DIR/${name}.txt"

    if [[ ! -f "$expect_file" ]]; then
        echo "FAIL $name: missing .expect file"
        return 1
    fi

    # Parse expect file
    local expected_exit
    expected_exit=$(head -1 "$expect_file" | sed 's/EXIT //')

    local args_line=""
    local expect_body_start=2
    if [[ $(sed -n '2p' "$expect_file") == ARGS:* ]]; then
        args_line=$(sed -n '2p' "$expect_file" | sed 's/ARGS: //')
        expect_body_start=3
    fi

    local expected_stdout
    expected_stdout=$(tail -n +"$expect_body_start" "$expect_file")

    # Build argument list
    local extra_args=()
    local use_root=true

    if [[ "$args_line" == "(none)" ]]; then
        use_root=false
    elif [[ "$args_line" == "--input FIXTURE_PATH" ]]; then
        extra_args+=("--input" "$txt_file")
    elif [[ -n "$args_line" ]]; then
        # split args_line into array
        read -ra extra_args <<< "$args_line"
        # check if --root is in extra_args to avoid duplicate
        for arg in "${extra_args[@]}"; do
            if [[ "$arg" == "--root" ]]; then
                use_root=false
                break
            fi
        done
    fi

    # Determine --root from fixture name (category hints: changelog/apireview/docdrift/reviewfindings)
    local root_arg=""
    if $use_root; then
        case "$name" in
            *changelog*) root_arg="Changelog" ;;
            *apireview*)  root_arg="ApiReview" ;;
            *docdrift*)   root_arg="DocDrift" ;;
            *reviewfindings*) root_arg="ReviewFindings" ;;
            *)            root_arg="Changelog" ;;  # fallback
        esac
    fi

    # Determine stdin source
    local stdin_file="/dev/null"
    if [[ -f "$txt_file" && "$args_line" != "--input FIXTURE_PATH" ]]; then
        stdin_file="$txt_file"
    fi

    # Build command
    local cmd=("$TOOL")
    if $use_root; then
        cmd+=("--root" "$root_arg")
    fi
    cmd+=("${extra_args[@]}")

    # Execute — capture stdout and exit code separately (pipefail off to allow exit!=0)
    local actual_stdout actual_exit
    actual_stdout=$("${cmd[@]}" < "$stdin_file" 2>/dev/null)
    actual_exit=$?

    # Normalize: strip trailing newline for comparison
    local norm_expected norm_actual
    norm_expected=$(printf '%s' "$expected_stdout" | sed 's/[[:space:]]*$//')
    norm_actual=$(printf '%s' "$actual_stdout" | sed 's/[[:space:]]*$//')

    local ok=true
    local reason=""

    if [[ "$actual_exit" != "$expected_exit" ]]; then
        ok=false
        reason="exit code: got $actual_exit, expected $expected_exit"
    elif [[ "$norm_actual" != "$norm_expected" ]]; then
        ok=false
        # Show first diff line
        reason="stdout mismatch (first diff line: $(diff <(echo "$norm_expected") <(echo "$norm_actual") | head -5 | tr '\n' ' '))"
    fi

    if $ok; then
        echo "PASS $name"
        return 0
    else
        echo "FAIL $name: $reason"
        return 1
    fi
}

# Collect results (sequential fixtures)
sequential_fixtures=(
    a1-changelog-clean
    a2-apireview-clean
    a3-docdrift-clean
    b1-changelog-preamble-fence
    b2-apireview-midprose
    b3-docdrift-multiparagraph
    c1-empty
    c2-pure-prose
    c3-truncated-strict
    c4-truncated-allow
    c5-japanese-unicode
    c6-backticks-in-strings
    c7-multi-object
    d1-input-flag
    d2-invalid-root
    d3-missing-root
    d4-invalid-schema
    e1-extra-fields
    e2-trailing-comma
    e3-markdown-in-strings
    e4-large-50-findings
    g1-reviewfindings-clean
    g2-reviewfindings-prose-fence
    g3-reviewfindings-prose-only
)

for name in "${sequential_fixtures[@]}"; do
    if run_fixture "$name"; then
        ((pass++))
    else
        ((fail++))
    fi
done

# F fixtures: run concurrently
echo "# Running F fixtures concurrently..."
declare -A f_results
declare -A f_pids

run_fixture_bg() {
    local name="$1"
    local result_file="/tmp/test_result_${name}"
    if run_fixture "$name" > "$result_file" 2>&1; then
        echo "0" >> "${result_file}.exit"
    else
        echo "1" >> "${result_file}.exit"
    fi
}

for fname in f1-parallel-changelog f2-parallel-apireview f3-parallel-docdrift; do
    run_fixture_bg "$fname" &
    f_pids[$fname]=$!
done

wait

for fname in f1-parallel-changelog f2-parallel-apireview f3-parallel-docdrift; do
    local_exit=$(cat "/tmp/test_result_${fname}.exit" 2>/dev/null || echo "1")
    cat "/tmp/test_result_${fname}" 2>/dev/null || true
    if [[ "$local_exit" == "0" ]]; then
        ((pass++))
    else
        ((fail++))
    fi
    rm -f "/tmp/test_result_${fname}" "/tmp/test_result_${fname}.exit"
done

total=$((pass + fail))
echo "RESULT: ${pass}/${total}"
[[ $fail -eq 0 ]]
