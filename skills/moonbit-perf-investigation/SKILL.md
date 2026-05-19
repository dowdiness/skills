---
name: moonbit-perf-investigation
description: Use BEFORE any performance optimization in MoonBit. Requires reproducing the claimed bottleneck in an isolated microbenchmark before designing a solution. Triggers on "optimize", "performance", "bottleneck", "slow", "speed up", or any TODO item citing millisecond costs. Do NOT skip this for "obvious" optimizations.
---

# Performance Investigation Gate

**HARD RULE:** Never design a performance optimization without first demonstrating the problem exists at measurable scale. This skill MUST run before brainstorming/designing any optimization.

## Why This Exists

We spent hours designing and implementing binary lifting jump pointers to replace an Euler Tour + Sparse Table LCA index based on a TODO claim of "3-5ms at 1000 items." Post-implementation benchmarks showed negligible improvement — the figure was stale (from before a prior optimization round) and existing mitigations already neutralized the hot paths.

## The Process

```
1. Identify the claim     → "X is slow" / "X costs Y ms" / "X is O(bad)"
2. Check staleness        → When was this measured? What changed since?
3. Check mitigations      → Is there already a batch mode, cache, or lazy eval?
4. Write microbenchmark   → Isolate the exact operation claimed to be slow
5. Run benchmark          → Does it reproduce the claimed cost?
   no      → STOP. Report finding. Find the real bottleneck.
   partial → Report actual cost. User decides if worth optimizing (often no).
   yes     → Prototype fix (50 lines, no spec) → benchmark again
             improved?     → THEN consider full design cycle if needed
             not improved? → STOP. Wrong approach.
```

## Step 1: Identify the Claim

What specific operation is claimed to be slow? Extract:
- The **operation** (e.g., "LCA index rebuild")
- The **claimed cost** (e.g., "3-5ms at 1000 items")
- The **source** (e.g., "TODO.md §5")
- The **context** (e.g., "per keystroke during live collaboration")

## Step 2: Check Staleness

**If there is no prior measurement at all** — e.g., the claim is pure asymptotic reasoning ("it's O(n²)") or intuition ("this feels slow") — treat this as worse than stale. Skip to Step 4 and write the microbenchmark. The HARD RULE applies with *more* force when no measurement has ever been taken, not less: there is no data point to verify against, so the benchmark becomes the first evidence either way.

```bash
# When was this measurement taken?
git log --all --oneline -- docs/TODO.md | head -5
git log --all --oneline -- docs/performance/ | head -5
# What optimizations landed since?
git log --oneline --since="<measurement_date>" -- <relevant_directory>
```

**Red flags:**
- Measurement predates a major refactoring (e.g., HashMap → Array migration)
- The profiling doc references types/functions that no longer exist
- The TODO item has been there for months without re-validation

If the measurement is stale, say so and suggest re-profiling before designing.

## Step 3: Check Existing Mitigations

Search for batch modes, caching, lazy evaluation, or other mitigations that may already neutralize the problem:

```bash
# Look for batch/cache/lazy patterns around the claimed bottleneck
grep -r "batch\|cache\|lazy\|invalidate\|skip\|fast.path" --include="*.mbt" <relevant_directory>
```

Ask: "Is this code path actually reached in the hot case, or is it already mitigated?"

## Step 4: Write Microbenchmark

Write a benchmark that isolates the **exact operation** claimed to be slow. Not a full pipeline benchmark — a microbenchmark.

```moonbit
///|
test "isolate: <operation name> at <N> items" (b : @bench.T) {
  // Setup: build realistic state
  // ...
  b.bench(fn() {
    // Measure ONLY the claimed slow operation
    // ...
    b.keep(result)
  })
}
```

**Rules:**
- Isolate the single operation, not the full pipeline
- Use realistic data (not trivial 10-item inputs)
- Use `--release` flag
- Fresh state per iteration if the operation mutates

## Step 5: Decision Gate

Run the benchmark. Three outcomes:

### Problem confirmed (operation IS slow)
Proceed to prototype a fix. Write 50 lines, benchmark again. If the prototype shows improvement, THEN consider whether a full spec/design cycle is needed.

### Problem not confirmed (operation is fast)
**STOP.** Report: "Benchmarked <operation> in isolation at <N> items: <X>µs. The claimed <Y>ms bottleneck is not reproducible. The TODO figure appears stale / already mitigated by <mechanism>."

Suggest: profile the full pipeline to find the actual bottleneck instead.

### Problem exists but smaller than claimed
Report the actual cost. Let the user decide if it's worth optimizing. Often it isn't.

## Step 6: Benchmark the Deployment Target

`moon bench --release` runs on the wasm-gc backend by default. MoonBit has three backends with very different performance characteristics:

- **JS**: V8's GC is fast for short-lived objects. Struct layout matters — wrapper objects and property dereferences have real cost. Best for measuring allocation-related optimizations.
- **wasm-gc**: GC-managed, no per-assignment RC. May optimize away single-field struct indirection. Middle ground.
- **C (native)**: Uses reference counting (`moonbit_incref`/`moonbit_decref`) on every pointer assignment. RC overhead can dominate and mask other differences. Can be slower than JS for allocation-heavy patterns.

A result that shows "no difference" on wasm-gc may show 10-15% on JS, or vice versa. C native results may be dominated by RC overhead. **The deployment target is the one that matters.**

## Anti-Patterns

| Anti-pattern | Why it's wrong |
|-------------|---------------|
| "O(n log n) is bad, let's fix it" | Asymptotic complexity is not a profile. O(n log n) at n=1000 with small constants can be microseconds. |
| "The TODO says it's the bottleneck" | TODOs record hypotheses, not measurements. Verify before acting. |
| "Let me design the ideal solution first" | You're optimizing for intellectual satisfaction, not user value. Measure first. |
| "The spec review will catch issues" | Spec reviews check solution correctness, not problem validity. |
| "It's architecturally cleaner anyway" | That's a refactoring argument, not a performance argument. If the goal is cleanliness, say so — don't dress it up as optimization. |

## MoonBit-Specific Cost Model Notes

Known codegen facts that affect optimization decisions. Verify with `moon build --target js` (or wasm) before assuming — compiler behavior changes across versions.

### Single-field tuple structs are unboxed (JS target, verified 2026-04-02)

A single-field tuple struct compiles to the inner value directly — no wrapper object, no indirection.

```moonbit
struct Wrapper(@hashmap.HashMap[Int, String])   // tuple struct: 1 field
struct Named { tokens : @hashmap.HashMap[Int, String] }  // named struct
```

**JS output:**
```js
// Wrapper::new() — returns bare HashMap, no wrapper allocation
function Wrapper_new() { return HashMap_new(8); }
// Wrapper::get() — self IS the HashMap
function Wrapper_get(self, key) { return HashMap_get(self, key); }

// Named::new() — allocates wrapper object
function Named_new() { return new Named(HashMap_new(8)); }
// Named::get() — dereferences .tokens
function Named_get(self, key) { return HashMap_get(self.tokens, key); }
```

The compiler also rejects `#valtype` on single-field tuple structs: *"Value type is not allowed for new type/tuple struct with one element (which is guaranteed unboxed at runtime)."*

**Tradeoff:** Tuple struct fields cannot be `priv`. If the struct is `pub` (not `pub(all)`), external packages can't construct it anyway, so the visibility loss is package-internal only.

**When it matters:** Wrapper types on hot paths (interners, caches, context objects) called hundreds of times per parse — saves one allocation + one dereference per call.

**Benchmark results (verified 2026-04-02, controlled side-by-side in same process):**

Two-level HashMap (Interner pattern: `HashMap[Int, HashMap[Int, String]]`, 110 calls/iter):

| Target | Named struct | Tuple struct | Speedup |
|--------|-------------|-------------|---------|
| JS (Node v24) | 5.84 µs/iter | 5.62 µs/iter | **~4%** |
| wasm-gc | 25.0 µs/iter | 25.9 µs/iter | **noise** |
| C (native, -O2) | 41.5 µs/iter | 43.0 µs/iter | **noise** |

Single-level HashMap (NodeInterner pattern: `HashMap[Int, Int]`, 110 calls/iter):

| Target | Named struct | Tuple struct | Speedup |
|--------|-------------|-------------|---------|
| JS (Node v24) | 1.33 µs/iter | 1.34 µs/iter | **noise** |

**Key finding:** Tuple struct unboxing only helps on JS, and only for complex access patterns (two-level maps). For single-level HashMap wrappers, V8's JIT optimizes away the property dereference after warmup.

**Methodology note:** Earlier separate-process benchmarks showed ~13% for the two-level case, but controlled side-by-side measurement in the same process shows ~4%. Separate processes introduce JIT warmup and memory layout differences that inflate the gap. Always prefer in-process side-by-side benchmarks.

**Why C native is slowest:** The C backend uses reference counting (`moonbit_incref`/`moonbit_decref`) on every pointer assignment. RC overhead dominates both variants equally.

**Why wasm-gc is middle:** GC-managed (no per-assignment RC), but wasm-gc runtime has its own overhead.

**Takeaway:** The JS target is where struct layout optimizations matter most — and Canopy targets the web. Always benchmark the deployment target, not just `moon bench` (which runs wasm-gc by default).

### Benchmarking JS output from MoonBit

`moon bench` only runs on the wasm-gc target. To benchmark JS codegen:

1. Build: `moon build --target js`
2. Find the output: `find _build/js -name "*.js"`
3. Extract the generated functions (they're top-level, not exported)
4. Write a Node.js harness that calls them with `performance.now()`:

```bash
# Strip the IIFE at the end, add timing harness
head -n <line_before_IIFE> _build/js/.../main.js > bench.js
cat >> bench.js << 'EOF'
const { performance } = require('perf_hooks');
const t0 = performance.now();
for (let i = 0; i < N; i++) fn_under_test();
console.log(((performance.now() - t0) / N * 1000).toFixed(2) + ' µs/iter');
EOF
node bench.js
```

This technique caught the 13% tuple struct win that was invisible to `moon bench`.

### `#valtype` on named structs requires non-abstract field types

`#valtype` on a named struct with an abstract type field (e.g., `HashMap` from another package) is rejected: *"Value type is not allowed for using abstract type as field type."*

This means `#valtype` is only useful for named structs whose fields are all concrete types from the same package or primitives.

## Integration with Brainstorming

When the brainstorming skill is invoked for a performance optimization:

1. **This skill runs FIRST** — before exploring approaches or asking about scale
2. If the problem is not confirmed, brainstorming should pivot to finding the real bottleneck
3. If the problem IS confirmed, brainstorming proceeds normally with the benchmark data as input

The benchmark result is the first thing presented in the design: "Measured: <X>µs baseline → target: <Y>µs."
