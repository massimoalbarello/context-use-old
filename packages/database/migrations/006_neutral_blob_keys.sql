ALTER TABLE public.hypermedia_document_revisions
  DROP CONSTRAINT hypermedia_document_revisions_body_object_key_check,
  ADD CONSTRAINT hypermedia_document_revisions_body_object_key_check CHECK (
    body_object_key ~ '^blobs/[0-9a-f-]{36}$'
    OR body_object_key ~ '^documents/private/[0-9a-f-]{36}\.md$'
  );

ALTER TABLE public.assets
  DROP CONSTRAINT assets_s3_object_key_check,
  ADD CONSTRAINT assets_s3_object_key_check CHECK (
    s3_object_key ~ '^blobs/[0-9a-f-]{36}$'
    OR s3_object_key ~ '^objects/[a-f0-9-]+$'
  );
