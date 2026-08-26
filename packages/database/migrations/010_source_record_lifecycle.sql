-- Provider-native identity survives Nango connection replacement. These
-- lifecycle functions expose only UUID/revision-scoped source-record actions;
-- this migration does not reconcile or mutate existing records.

GRANT UPDATE(connection_instance_id) ON source_records TO context_use_mcp;

GRANT SELECT(current_revision_id,deleted_at) ON source_records
  TO context_use_boundary_owner;
GRANT DELETE ON source_records TO context_use_boundary_owner;

CREATE FUNCTION archive_source_record(
  p_document_id uuid,
  p_expected_revision_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE target record;
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'source record document ID is required' USING ERRCODE='22023';
  END IF;

  SELECT record.current_revision_id,record.deleted_at INTO target
  FROM source_records record
  WHERE record.document_id=p_document_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target.current_revision_id IS DISTINCT FROM p_expected_revision_id THEN
    RETURN 'revision_conflict';
  END IF;
  IF target.deleted_at IS NOT NULL THEN RETURN 'archived'; END IF;

  UPDATE source_records
  SET deleted_at=now(),search_vector=''::tsvector
  WHERE document_id=p_document_id;
  DELETE FROM source_record_search_chunks WHERE document_id=p_document_id;
  RETURN 'archived';
END;
$$;

ALTER FUNCTION archive_source_record(uuid,uuid)
  OWNER TO context_use_boundary_owner;
REVOKE ALL ON FUNCTION archive_source_record(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_source_record(uuid,uuid)
  TO context_use_dashboard,context_use_mcp;

CREATE FUNCTION delete_archived_source_record(
  p_document_id uuid,
  p_expected_revision_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE target record;
BEGIN
  IF p_document_id IS NULL THEN
    RAISE EXCEPTION 'source record document ID is required' USING ERRCODE='22023';
  END IF;

  SELECT record.current_revision_id,record.deleted_at INTO target
  FROM source_records record
  WHERE record.document_id=p_document_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target.current_revision_id IS DISTINCT FROM p_expected_revision_id THEN
    RETURN 'revision_conflict';
  END IF;
  IF target.deleted_at IS NULL THEN RETURN 'not_archived'; END IF;

  DELETE FROM source_records WHERE document_id=p_document_id;
  DELETE FROM hypermedia_documents
  WHERE id=p_document_id AND authority='source';
  RETURN 'deleted';
END;
$$;

ALTER FUNCTION delete_archived_source_record(uuid,uuid)
  OWNER TO context_use_boundary_owner;
REVOKE ALL ON FUNCTION delete_archived_source_record(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_archived_source_record(uuid,uuid)
  TO context_use_dashboard;
