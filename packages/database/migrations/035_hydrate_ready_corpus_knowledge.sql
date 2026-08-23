-- Corpus migration completion receipts bind a current knowledge revision to a
-- stable run. Use that proof to hydrate the pathless contract/search projection
-- both while applying a run and while auditing a run sealed by older code.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE FUNCTION hydrate_corpus_knowledge_revision(
  p_run_id uuid,
  p_document_id uuid,
  p_revision_id uuid,
  p_body_markdown text,
  p_target_document_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  contract_provenance knowledge_revision_contract_provenance;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('filesystem-hypermedia-corpus-transition',0)
  );
  PERFORM run.id
  FROM corpus_migration_runs run
  WHERE run.id=p_run_id AND run.phase IN ('applying','ready')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active corpus run is unavailable for knowledge hydration'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1
  FROM corpus_migration_completions completion
  WHERE completion.run_id=p_run_id
    AND completion.item_kind IN ('page','directory')
    AND completion.output_document_id=p_document_id
    AND completion.output_revision_id=p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge revision is not an output of the corpus run'
      USING ERRCODE='23514';
  END IF;

  SELECT contract.provenance
  INTO contract_provenance
  FROM knowledge_revision_contracts contract
  WHERE contract.revision_id=p_revision_id;
  IF NOT FOUND THEN
    contract_provenance := 'corpus_migration';
  END IF;

  RETURN record_generic_knowledge_revision(
    p_document_id,p_revision_id,p_body_markdown,p_target_document_ids,
    contract_provenance
  );
END;
$$;

REVOKE ALL ON FUNCTION hydrate_corpus_knowledge_revision(
  uuid,uuid,uuid,text,uuid[]
) FROM PUBLIC;

GRANT SELECT (id,phase) ON corpus_migration_runs
  TO context_use_boundary_owner;
GRANT SELECT (
  run_id,item_kind,output_document_id,output_revision_id
) ON corpus_migration_completions TO context_use_boundary_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION hydrate_corpus_knowledge_revision(
  uuid,uuid,uuid,text,uuid[]
) OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT EXECUTE ON FUNCTION hydrate_corpus_knowledge_revision(
  uuid,uuid,uuid,text,uuid[]
) TO context_use_corpus;
