import type { PageEntityType } from "@context-use/shared";

export type KnowledgePage = {
  id: string;
  current_version_id: string;
  published_version_id: string | null;
  published_version_number: number | null;
  public_id: string | null;
  archived_at: string | null;
  version_number: number;
  entity_type: PageEntityType | null;
  title: string;
  summary: string;
  body_markdown: string;
  rendered_html: string;
  public_url: string | null;
  created_at: string;
  updated_at: string;
};

export type SourceRecordPage = {
  id: string;
  current_version_id: string | null;
  version_number: number | null;
  integration: string;
  model: string;
  source_updated_at: string;
  deleted_at: string | null;
  rendered_html: string;
};

export type Version = {
  id: string;
  page_id: string;
  version_number: number;
  entity_type: PageEntityType | null;
  title: string;
  summary: string;
  body_markdown?: string;
  commit_message: string;
  actor_kind: "dashboard" | "mcp";
  actor_subject: string;
  created_at: string;
};

export type KnowledgePageHistory = {
  revisions: Version[];
  has_more: boolean;
};

export type PageVersionDiff = {
  page_id: string;
  comparison: {
    from_version: number | null;
    to_version: number;
  };
  metadata_changes: Array<{
    field: "title" | "summary" | "entity_type";
    before: string | null;
    after: string | null;
  }>;
  markdown_changes: Array<{
    before: string;
    after: string;
  }>;
};

export type KnowledgePageChange = {
  cursor: string;
  object_id: string;
  revision_id: string;
  revision_number: number;
  previous_revision_number: number | null;
  change_kind: "created" | "updated" | "archived" | "deleted";
  title: string;
  commit_message: string;
  actor_kind: "dashboard" | "mcp" | null;
  actor_subject: string | null;
  changed_at: string;
};

export type KnowledgePageChangeBatch = {
  changes: KnowledgePageChange[];
  next_cursor: string;
  has_more: boolean;
};

export type Asset = {
  id: string;
  public_id: string | null;
  published: boolean;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_hash: string;
  created_at: string;
};

export type AssetStatus = {
  content_available: boolean;
  public_url: string | null;
  published: boolean;
};

/**
 * What republishing releases: everything written since the pinned public version, which the
 * owner has not necessarily seen. Imported or historically incomplete data can
 * still make a long sequence incomplete, which is reported separately.
 */
export type RepublicationReview = {
  published_version_number: number;
  metadata_changes: Array<{
    field: "title" | "summary" | "entity_type";
    before: string | null;
    after: string | null;
  }>;
  markdown_changes: Array<{ before: string; after: string }>;
  queued_versions: Array<{
    version_number: number;
    commit_message: string;
    actor_kind: "dashboard" | "mcp" | null;
    actor_subject: string | null;
    created_at: string;
  }>;
  queued_versions_complete: boolean;
};

export type PublicationPreview = {
  page_id: string;
  version_id: string;
  version_number: number;
  title: string;
  summary: string;
  rendered_html: string;
  current_public_url: string | null;
  warnings: string[];
  references: Array<{
    kind: "page" | "asset" | "record" | "object";
    id: string;
    label: string;
    public: boolean;
    public_url: string | null;
  }>;
  republication: RepublicationReview | null;
};

export type ConnectedClient = {
  client_id: string;
  name: string | null;
  uri: string | null;
  version: string | null;
  created_at: string;
  approved_at: string;
  last_connected_at: string | null;
};

export type PaginatedResponse<T> = {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export type InboundMessage = {
  id: string;
  reply_to: string;
  message: string;
  created_at: string;
};
