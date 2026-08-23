-- Once the audited cutover is permanent, let the isolated corpus one-shot
-- observe only that completion timestamp. It uses this narrow projection to
-- skip every retained filesystem migration/adoption path on later deploys.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

GRANT SELECT (singleton,finalized_at) ON hypermedia_cutover_state
  TO context_use_corpus;
