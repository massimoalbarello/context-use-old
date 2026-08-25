-- The confirmation service verifies that an export intent still has its
-- corresponding bundle job before consuming the passkey challenge. Keep that
-- preflight available without exposing bundle status or progress metadata.
GRANT SELECT (intent_id) ON knowledge_bundle_exports
  TO context_use_confirmation;
