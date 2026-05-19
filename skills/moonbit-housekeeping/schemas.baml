// BAML schemas for moonbit-housekeeping release and Codex worker outputs.
// Used by parse-worker-output.py (baml-lib parse-only mode) to extract
// validated JSON from prose-leaky worker outputs.
//
// Enum fields are declared as `string` (not BAML enums) so the schema is
// lenient on exact enum values — the goal is structural validation +
// preamble/code-fence stripping, not exact value enforcement.

class ChangelogBase {
  type string
  value string
}

class ChangelogEntry {
  description string
  commits string[]
  breaking bool
}

class ChangelogSection {
  type string
  entries ChangelogEntry[]
}

class Changelog {
  category string
  status string
  base ChangelogBase
  total_commits int
  suggested_bump string
  bump_confidence string
  sections ChangelogSection[]
  skipped_commits string[]?
  truncated bool
  tool_calls_used int
}

class ApiReviewFinding {
  file string
  change_type string
  symbol string
  classification string
  confidence string
  severity string
  evidence string[]
  breaking bool
}

class ApiReviewSummary {
  added int
  removed int
  modified int
  breaking_changes int
}

class ApiReview {
  category string
  status string
  findings ApiReviewFinding[]
  summary ApiReviewSummary
  truncated bool
  tool_calls_used int
}

class DocDriftFinding {
  doc_file string
  reference string
  reference_type string
  classification string
  confidence string
  severity string
  evidence string[]
  recommendation string
}

class DocDrift {
  category string
  status string
  findings DocDriftFinding[]
  docs_checked int
  references_checked int
  truncated bool
  tool_calls_used int
}

class ReviewFinding {
  severity string
  file string
  line int?
  claim string
  evidence string[]
  confidence string
  requires_change bool
}

class ReviewFindings {
  category string
  status string
  findings ReviewFinding[]
  truncated bool
  tool_calls_used int
}
