# Structured Worker Output Intake

Read this reference when accepting structured worker JSON. Parsing validates
structure, not the truth of a finding: check material claims against source
files, lines, diffs, or command/test evidence before including them in a report.

1. Try a strict JSON parse of the raw output first. Even valid JSON must satisfy
   the expected schema before it is accepted.
2. For the bundled schemas, pass each raw output through the adjacent
   [parse-worker-output.py](../parse-worker-output.py). It uses
   [schemas.baml](../schemas.baml) for schema validation and can extract output
   wrapped in prose or code fences. Resolve the executable relative to the
   installed `moonbit-housekeeping` skill directory, not the task repository.

   ```bash
   /path/to/moonbit-housekeeping/parse-worker-output.py --root Changelog --input worker.txt
   ```

   Select one root per output:

   | Output | Root |
   |--------|------|
   | Release changelog | `Changelog` |
   | Release API review | `ApiReview` |
   | Release documentation drift | `DocDrift` |
   | Review findings using the bundled review schema | `ReviewFindings` |

   The executable uses `uv` to provide Python and `baml-lib`; its declared
   dependencies may be downloaded on first use. Preserve the original output
   for diagnosis. Do not accept partial results as a complete report.
3. If parsing or schema validation fails, re-request JSON-only output from the
   worker. Do not bypass validation with brace extraction or regex cleanup.
   If the parser is unavailable, report that limitation; a re-request still
   needs strict parsing and validation against its declared schema.

For schemas outside this bundle, use their declared validator; do not force
unrelated output into a release or review root. The ordinary Markdown reports
from `parallel-review` do not need to be converted into JSON.

Do not claim trailing commas are supported: `e2-trailing-comma` is expected to
fail in [the parser regression suite](../tests/run-tests.nu). Parse/schema
failure and a valid report containing no findings are different outcomes.
