-- Make every pathless public artifact write a database-claimed, object-store
-- create-only operation before the immutable staging receipt can be recorded.
-- The pathless publication APIs remain dormant; this migration closes the
-- storage TOCTOU prerequisite without cutting over any route.

SELECT pg_advisory_xact_lock(
  hashtextextended('filesystem-hypermedia-corpus-transition',0)
);

CREATE TABLE pathless_publication_object_claims (
  allocation_kind public_artifact_allocation_kind NOT NULL CHECK (
    allocation_kind IN ('pathless_intent','pathless_adoption')
  ),
  allocation_id uuid NOT NULL,
  artifact_id uuid NOT NULL UNIQUE,
  body_object_key text NOT NULL UNIQUE,
  claim_token uuid NOT NULL UNIQUE,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  body_size_bytes bigint,
  body_content_hash text,
  PRIMARY KEY (allocation_kind,allocation_id),
  FOREIGN KEY (artifact_id,body_object_key,allocation_kind,allocation_id)
    REFERENCES public_artifact_id_reservations(
      artifact_id,body_object_key,allocation_kind,allocation_id
    ),
  CHECK (
    (finalized_at IS NULL
      AND body_size_bytes IS NULL
      AND body_content_hash IS NULL)
    OR
    (finalized_at IS NOT NULL
      AND body_size_bytes IS NOT NULL AND body_size_bytes>=0
      AND body_content_hash ~ '^[a-f0-9]{64}$')
  )
);

-- Existing immutable staging rows predate the claim protocol. Backfill them as
-- finalized so upgrades preserve exact lost-reply replay and every subsequent
-- staging insert can require a durable claim.
INSERT INTO pathless_publication_object_claims(
  allocation_kind,allocation_id,artifact_id,body_object_key,claim_token,
  claimed_at,finalized_at,body_size_bytes,body_content_hash
)
SELECT 'pathless_intent'::public_artifact_allocation_kind,
  staging.intent_id,staging.artifact_id,
  staging.body_object_key,gen_random_uuid(),staging.staged_at,
  staging.staged_at,staging.body_size_bytes,staging.body_content_hash
FROM pathless_publication_artifact_staging staging
UNION ALL
SELECT 'pathless_adoption'::public_artifact_allocation_kind,
  staging.adoption_id,staging.artifact_id,
  staging.body_object_key,gen_random_uuid(),staging.staged_at,
  staging.staged_at,staging.body_size_bytes,staging.body_content_hash
FROM pathless_publication_adoption_staging staging;

CREATE FUNCTION guard_pathless_publication_object_claim_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pathless publication object claims are permanent'
      USING ERRCODE='55000';
  END IF;
  IF OLD.finalized_at IS NULL
     AND NEW.finalized_at IS NOT NULL
     AND NEW.allocation_kind=OLD.allocation_kind
     AND NEW.allocation_id=OLD.allocation_id
     AND NEW.artifact_id=OLD.artifact_id
     AND NEW.body_object_key=OLD.body_object_key
     AND NEW.claim_token=OLD.claim_token
     AND NEW.claimed_at=OLD.claimed_at
     AND NEW.body_size_bytes IS NOT NULL
     AND NEW.body_size_bytes>=0
     AND NEW.body_content_hash ~ '^[a-f0-9]{64}$' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pathless publication object claims are immutable after finalization'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER pathless_publication_claims_030_keep_history
BEFORE UPDATE OR DELETE ON pathless_publication_object_claims
FOR EACH ROW EXECUTE FUNCTION guard_pathless_publication_object_claim_history();

CREATE FUNCTION require_finalized_pathless_publication_object_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
DECLARE
  claim pathless_publication_object_claims%ROWTYPE;
  expected_kind public_artifact_allocation_kind;
  expected_id uuid;
BEGIN
  IF TG_TABLE_NAME='pathless_publication_artifact_staging' THEN
    expected_kind := 'pathless_intent';
    expected_id := NEW.intent_id;
  ELSIF TG_TABLE_NAME='pathless_publication_adoption_staging' THEN
    expected_kind := 'pathless_adoption';
    expected_id := NEW.adoption_id;
  ELSE
    RAISE EXCEPTION 'unexpected pathless publication staging table'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO claim
  FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind=expected_kind
    AND stored.allocation_id=expected_id
  FOR SHARE;
  IF NOT FOUND OR claim.finalized_at IS NULL
     OR claim.artifact_id IS DISTINCT FROM NEW.artifact_id
     OR claim.body_object_key IS DISTINCT FROM NEW.body_object_key
     OR claim.body_size_bytes IS DISTINCT FROM NEW.body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM NEW.body_content_hash THEN
    RAISE EXCEPTION 'publication artifact requires an exact finalized object claim'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pathless_publication_staging_030_require_claim
BEFORE INSERT ON pathless_publication_artifact_staging
FOR EACH ROW EXECUTE FUNCTION require_finalized_pathless_publication_object_claim();
CREATE TRIGGER pathless_adoption_staging_030_require_claim
BEFORE INSERT ON pathless_publication_adoption_staging
FOR EACH ROW EXECUTE FUNCTION require_finalized_pathless_publication_object_claim();

-- Challenge issuance and claim finalization share target->intent->claim order.
-- A challenge can begin only after the object is conditionally created,
-- verified, finalized, and staged in one transaction.
CREATE FUNCTION reject_pending_pathless_publication_claim_challenge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $$
BEGIN
  IF NEW.intent_kind='publication' AND EXISTS (
    SELECT 1
    FROM publication_intent_id_reservations reservation
    JOIN pathless_publication_object_claims claim
      ON claim.allocation_kind='pathless_intent'
     AND claim.allocation_id=reservation.intent_id
    WHERE reservation.intent_id=NEW.intent_id
      AND reservation.intent_store='pathless'
      AND claim.finalized_at IS NULL
    FOR SHARE OF claim
  ) THEN
    RAISE EXCEPTION 'publication artifact write is still in progress'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER confirmation_challenges_030_reject_pending_object_claim
BEFORE INSERT ON confirmation_challenges
FOR EACH ROW EXECUTE FUNCTION reject_pending_pathless_publication_claim_challenge();

CREATE FUNCTION claim_pathless_publication_artifact(
  p_intent_id uuid,
  p_claim_token uuid
) RETURNS TABLE (
  claim_token uuid,
  finalized boolean,
  artifact_id uuid,
  body_object_key text,
  body_size_bytes bigint,
  body_content_hash text,
  authorization jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  existing pathless_publication_object_claims%ROWTYPE;
  target record;
BEGIN
  IF p_intent_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'publication allocation and claim token are required'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing
  FROM pathless_publication_object_claims claim
  WHERE claim.allocation_kind='pathless_intent'
    AND claim.allocation_id=p_intent_id;
  IF FOUND AND existing.finalized_at IS NOT NULL THEN
    RETURN QUERY SELECT existing.claim_token,true,existing.artifact_id,
      existing.body_object_key,existing.body_size_bytes,
      existing.body_content_hash,NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO target FROM get_pathless_publication_write_target(p_intent_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication write target was not returned'
      USING ERRCODE='P0002';
  END IF;
  IF existing.allocation_id IS NULL THEN
    INSERT INTO pathless_publication_object_claims(
      allocation_kind,allocation_id,artifact_id,body_object_key,claim_token
    ) VALUES (
      'pathless_intent',p_intent_id,target.artifact_id,
      target.body_object_key,p_claim_token
    )
    ON CONFLICT (allocation_kind,allocation_id) DO NOTHING;
  END IF;
  SELECT * INTO existing
  FROM pathless_publication_object_claims claim
  WHERE claim.allocation_kind='pathless_intent'
    AND claim.allocation_id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND
     OR existing.artifact_id IS DISTINCT FROM target.artifact_id
     OR existing.body_object_key IS DISTINCT FROM target.body_object_key THEN
    RAISE EXCEPTION 'publication object claim does not match its allocation'
      USING ERRCODE='23505';
  END IF;
  RETURN QUERY SELECT existing.claim_token,false,existing.artifact_id,
    existing.body_object_key,NULL::bigint,NULL::text,to_jsonb(target);
END;
$$;

CREATE FUNCTION finalize_pathless_publication_artifact_claim(
  p_claim_token uuid,
  p_intent_id uuid,
  p_target_kind publication_target,
  p_body_size_bytes bigint,
  p_body_content_hash text,
  p_public_title text,
  p_public_summary text,
  p_public_last_edited_at timestamptz,
  p_public_filename text,
  p_public_content_type text,
  p_public_width integer,
  p_public_height integer,
  p_public_duration_seconds text,
  p_projected_target_public_ids uuid[],
  p_observed_public_uuid_tokens uuid[],
  p_projection_receipt_hash text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  claim pathless_publication_object_claims%ROWTYPE;
BEGIN
  SELECT * INTO claim
  FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind='pathless_intent'
    AND stored.allocation_id=p_intent_id;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'publication object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NOT NULL THEN
    IF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
      RAISE EXCEPTION 'publication object claim finalization does not match'
        USING ERRCODE='23505';
    END IF;
    PERFORM stage_pathless_publication_artifact(
      p_intent_id,p_target_kind,p_body_size_bytes,p_body_content_hash,
      p_public_title,p_public_summary,p_public_last_edited_at,
      p_public_filename,p_public_content_type,p_public_width,p_public_height,
      p_public_duration_seconds,p_projected_target_public_ids,
      p_observed_public_uuid_tokens,p_projection_receipt_hash
    );
    RETURN;
  END IF;
  -- Lock the target and intent before the claim row. This matches challenge
  -- issuance and prevents a storage-finalize/confirmation lock inversion.
  PERFORM 1 FROM get_pathless_publication_write_target(p_intent_id);
  SELECT * INTO claim
  FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind='pathless_intent'
    AND stored.allocation_id=p_intent_id
  FOR UPDATE;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'publication object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NULL THEN
    UPDATE pathless_publication_object_claims stored
    SET finalized_at=now(),body_size_bytes=p_body_size_bytes,
      body_content_hash=p_body_content_hash
    WHERE stored.allocation_kind='pathless_intent'
      AND stored.allocation_id=p_intent_id;
  ELSIF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
    RAISE EXCEPTION 'publication object claim finalization does not match'
      USING ERRCODE='23505';
  END IF;
  PERFORM stage_pathless_publication_artifact(
    p_intent_id,p_target_kind,p_body_size_bytes,p_body_content_hash,
    p_public_title,p_public_summary,p_public_last_edited_at,
    p_public_filename,p_public_content_type,p_public_width,p_public_height,
    p_public_duration_seconds,p_projected_target_public_ids,
    p_observed_public_uuid_tokens,p_projection_receipt_hash
  );
END;
$$;

CREATE FUNCTION claim_pathless_publication_adoption_artifact(
  p_adoption_id uuid,
  p_claim_token uuid
) RETURNS TABLE (
  claim_token uuid,
  finalized boolean,
  artifact_id uuid,
  body_object_key text,
  body_size_bytes bigint,
  body_content_hash text,
  authorization jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
AS $$
DECLARE
  existing pathless_publication_object_claims%ROWTYPE;
  target record;
BEGIN
  IF p_adoption_id IS NULL OR p_claim_token IS NULL THEN
    RAISE EXCEPTION 'adoption allocation and claim token are required'
      USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing
  FROM pathless_publication_object_claims claim
  WHERE claim.allocation_kind='pathless_adoption'
    AND claim.allocation_id=p_adoption_id;
  IF FOUND AND existing.finalized_at IS NOT NULL THEN
    RETURN QUERY SELECT existing.claim_token,true,existing.artifact_id,
      existing.body_object_key,existing.body_size_bytes,
      existing.body_content_hash,NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO target
  FROM get_pathless_publication_adoption_write_target(p_adoption_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'adoption write target was not returned'
      USING ERRCODE='P0002';
  END IF;
  IF existing.allocation_id IS NULL THEN
    INSERT INTO pathless_publication_object_claims(
      allocation_kind,allocation_id,artifact_id,body_object_key,claim_token
    ) VALUES (
      'pathless_adoption',p_adoption_id,target.artifact_id,
      target.body_object_key,p_claim_token
    )
    ON CONFLICT (allocation_kind,allocation_id) DO NOTHING;
  END IF;
  SELECT * INTO existing
  FROM pathless_publication_object_claims claim
  WHERE claim.allocation_kind='pathless_adoption'
    AND claim.allocation_id=p_adoption_id
  FOR UPDATE;
  IF NOT FOUND
     OR existing.artifact_id IS DISTINCT FROM target.artifact_id
     OR existing.body_object_key IS DISTINCT FROM target.body_object_key THEN
    RAISE EXCEPTION 'adoption object claim does not match its allocation'
      USING ERRCODE='23505';
  END IF;
  RETURN QUERY SELECT existing.claim_token,false,existing.artifact_id,
    existing.body_object_key,NULL::bigint,NULL::text,to_jsonb(target);
END;
$$;

CREATE FUNCTION finalize_pathless_publication_adoption_claim(
  p_claim_token uuid,
  p_adoption_id uuid,
  p_adoption_kind pathless_publication_adoption_kind,
  p_body_size_bytes bigint,
  p_body_content_hash text,
  p_public_title text,
  p_public_summary text,
  p_public_last_edited_at timestamptz,
  p_public_filename text,
  p_public_content_type text,
  p_public_width integer,
  p_public_height integer,
  p_public_duration_seconds text,
  p_projected_target_public_ids uuid[],
  p_observed_public_uuid_tokens uuid[],
  p_projection_receipt_hash text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
SET jit=off
SET TimeZone='UTC'
AS $$
DECLARE
  claim pathless_publication_object_claims%ROWTYPE;
BEGIN
  SELECT * INTO claim
  FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind='pathless_adoption'
    AND stored.allocation_id=p_adoption_id;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'adoption object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NOT NULL THEN
    IF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
       OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
      RAISE EXCEPTION 'adoption object claim finalization does not match'
        USING ERRCODE='23505';
    END IF;
    PERFORM stage_pathless_publication_adoption(
      p_adoption_id,p_adoption_kind,p_body_size_bytes,p_body_content_hash,
      p_public_title,p_public_summary,p_public_last_edited_at,
      p_public_filename,p_public_content_type,p_public_width,p_public_height,
      p_public_duration_seconds,p_projected_target_public_ids,
      p_observed_public_uuid_tokens,p_projection_receipt_hash
    );
    RETURN;
  END IF;
  PERFORM 1 FROM get_pathless_publication_adoption_write_target(p_adoption_id);
  SELECT * INTO claim
  FROM pathless_publication_object_claims stored
  WHERE stored.allocation_kind='pathless_adoption'
    AND stored.allocation_id=p_adoption_id
  FOR UPDATE;
  IF NOT FOUND OR claim.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'adoption object claim is unavailable'
      USING ERRCODE='55000';
  END IF;
  IF claim.finalized_at IS NULL THEN
    UPDATE pathless_publication_object_claims stored
    SET finalized_at=now(),body_size_bytes=p_body_size_bytes,
      body_content_hash=p_body_content_hash
    WHERE stored.allocation_kind='pathless_adoption'
      AND stored.allocation_id=p_adoption_id;
  ELSIF claim.body_size_bytes IS DISTINCT FROM p_body_size_bytes
     OR claim.body_content_hash IS DISTINCT FROM p_body_content_hash THEN
    RAISE EXCEPTION 'adoption object claim finalization does not match'
      USING ERRCODE='23505';
  END IF;
  PERFORM stage_pathless_publication_adoption(
    p_adoption_id,p_adoption_kind,p_body_size_bytes,p_body_content_hash,
    p_public_title,p_public_summary,p_public_last_edited_at,
    p_public_filename,p_public_content_type,p_public_width,p_public_height,
    p_public_duration_seconds,p_projected_target_public_ids,
    p_observed_public_uuid_tokens,p_projection_receipt_hash
  );
END;
$$;

REVOKE ALL ON pathless_publication_object_claims FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_pathless_publication_object_claim_history()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION require_finalized_pathless_publication_object_claim()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_pending_pathless_publication_claim_challenge()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pathless_publication_artifact(uuid,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_pathless_publication_artifact_claim(
  uuid,uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
  integer,integer,text,uuid[],uuid[],text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_pathless_publication_adoption_artifact(uuid,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_pathless_publication_adoption_claim(
  uuid,uuid,pathless_publication_adoption_kind,bigint,text,text,text,
  timestamptz,text,text,integer,integer,text,uuid[],uuid[],text
) FROM PUBLIC;

GRANT SELECT,INSERT ON pathless_publication_object_claims
  TO context_use_pathless_storage_owner;
GRANT UPDATE (finalized_at,body_size_bytes,body_content_hash)
  ON pathless_publication_object_claims TO context_use_pathless_storage_owner;
GRANT SELECT (
  allocation_kind,allocation_id,artifact_id,body_object_key,claim_token,
  claimed_at,finalized_at,body_size_bytes,body_content_hash
) ON pathless_publication_object_claims TO context_use_boundary_owner;
-- PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE row locks.
GRANT UPDATE (allocation_id)
  ON pathless_publication_object_claims TO context_use_boundary_owner;
GRANT SELECT (allocation_kind,allocation_id)
  ON pathless_publication_object_claims TO context_use_reset_owner;
GRANT SELECT ON pathless_publication_object_claims TO context_use_backup;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_boundary_owner;
ALTER FUNCTION guard_pathless_publication_object_claim_history()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION require_finalized_pathless_publication_object_claim()
  OWNER TO context_use_boundary_owner;
ALTER FUNCTION reject_pending_pathless_publication_claim_challenge()
  OWNER TO context_use_boundary_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_boundary_owner;

GRANT USAGE,CREATE ON SCHEMA public TO context_use_pathless_storage_owner;
ALTER FUNCTION claim_pathless_publication_artifact(uuid,uuid)
  OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION finalize_pathless_publication_artifact_claim(
  uuid,uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
  integer,integer,text,uuid[],uuid[],text
) OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION claim_pathless_publication_adoption_artifact(uuid,uuid)
  OWNER TO context_use_pathless_storage_owner;
ALTER FUNCTION finalize_pathless_publication_adoption_claim(
  uuid,uuid,pathless_publication_adoption_kind,bigint,text,text,text,
  timestamptz,text,text,integer,integer,text,uuid[],uuid[],text
) OWNER TO context_use_pathless_storage_owner;
REVOKE CREATE ON SCHEMA public FROM context_use_pathless_storage_owner;

GRANT EXECUTE ON FUNCTION stage_pathless_publication_artifact(
  uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
  integer,integer,text,uuid[],uuid[],text
),stage_pathless_publication_adoption(
  uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamptz,
  text,text,integer,integer,text,uuid[],uuid[],text
) TO context_use_pathless_storage_owner;

REVOKE EXECUTE ON FUNCTION get_pathless_publication_write_target(uuid),
  stage_pathless_publication_artifact(
    uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
    integer,integer,text,uuid[],uuid[],text
  ),get_pathless_publication_adoption_write_target(uuid),
  stage_pathless_publication_adoption(
    uuid,pathless_publication_adoption_kind,bigint,text,text,text,timestamptz,
    text,text,integer,integer,text,uuid[],uuid[],text
  ) FROM context_use_storage;
GRANT EXECUTE ON FUNCTION claim_pathless_publication_artifact(uuid,uuid),
  finalize_pathless_publication_artifact_claim(
    uuid,uuid,publication_target,bigint,text,text,text,timestamptz,text,text,
    integer,integer,text,uuid[],uuid[],text
  ),claim_pathless_publication_adoption_artifact(uuid,uuid),
  finalize_pathless_publication_adoption_claim(
    uuid,uuid,pathless_publication_adoption_kind,bigint,text,text,text,
    timestamptz,text,text,integer,integer,text,uuid[],uuid[],text
  ) TO context_use_storage;
