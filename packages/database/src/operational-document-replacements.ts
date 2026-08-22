import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { extractDocumentLinks } from "./links.ts";

export type OperationalDocumentReplacementTarget =
  | { kind: "global_guide" }
  | {
    kind: "automation_instructions";
    key: string;
    name: string;
    state: OperationalAutomationStateTarget;
  };

export type OperationalAutomationStateTarget =
  | null
  | { mode: "existing"; document_id: string }
  | {
    mode: "clone";
    source_document_id: string;
    source_revision_id: string;
    title: string;
    summary: string;
    body_size_bytes: number;
    body_content_hash: string;
  };

export type ManagedOperationalDocument = {
  title: string;
  summary: string;
  body_size_bytes: number;
  body_content_hash: string;
};

export type BeginOperationalDocumentReplacementInput = {
  target: OperationalDocumentReplacementTarget;
  source_document_id: string;
  source_revision_id: string;
  managed: ManagedOperationalDocument;
  actor_subject: string;
};

export type OperationalDocumentReplacementPlan = {
  replacement_id: string;
  phase: "planned" | "applied";
  target: OperationalDocumentReplacementTarget;
  source_document_id: string;
  source_revision_id: string;
  replacement_document_id: string;
  replacement_path: string;
  replacement_revision: {
    revision_id: string;
    revision_number: 1;
    body_object_key: string;
  };
  managed: ManagedOperationalDocument;
  agents_occupant_preservation: null | {
    document_id: string;
    source_revision_id: string;
    path: string;
    title: string;
    summary: string;
    revision: {
      revision_id: string;
      revision_number: number;
      body_object_key: string;
    };
    body_size_bytes: number;
    body_content_hash: string;
  };
  registration_id: string | null;
  state: null | {
    mode: "existing";
    document_id: string;
  } | {
    mode: "clone";
    source_document_id: string;
    source_revision_id: string;
    replacement_document_id: string;
    replacement_path: string;
    replacement_revision: {
      revision_id: string;
      revision_number: 1;
      body_object_key: string;
    };
    title: string;
    summary: string;
    body_size_bytes: number;
    body_content_hash: string;
  };
};

export type ApplyOperationalDocumentReplacementInput = {
  replacement_id: string;
  revision: {
    id: string;
    body_object_key: string;
    body_size_bytes: number;
    body_content_hash: string;
  };
  body_markdown_for_index: string;
  target_document_ids: string[];
  agents_occupant_preservation?: {
    revision: {
      id: string;
      body_object_key: string;
      body_size_bytes: number;
      body_content_hash: string;
    };
    body_markdown_for_index: string;
    target_document_ids: string[];
  };
  state_clone?: {
    revision: {
      id: string;
      body_object_key: string;
      body_size_bytes: number;
      body_content_hash: string;
    };
    body_markdown_for_index: string;
    target_document_ids: string[];
  };
};

export class OperationalDocumentReplacementDriftError extends Error {
  readonly code = "operational_document_replacement_drift";

  constructor(readonly replacement_id: string | null) {
    super("Operational document replacement was superseded by authority drift");
    this.name = "OperationalDocumentReplacementDriftError";
  }
}

type ReplacementRow = {
  id: string;
  target_kind: "global_guide" | "automation_instructions";
  target_key: string | null;
  source_document_id: string;
  source_revision_id: string;
  agents_occupant_document_id: string | null;
  agents_occupant_source_revision_id: string | null;
  agents_occupant_preservation_revision_id: string | null;
  agents_occupant_preservation_revision_number: number | null;
  agents_occupant_preservation_path: string | null;
  agents_occupant_preservation_title: string | null;
  agents_occupant_preservation_summary: string | null;
  agents_occupant_preservation_body_object_key: string | null;
  agents_occupant_preservation_body_size_bytes: number | string | null;
  agents_occupant_preservation_body_content_hash: string | null;
  replacement_document_id: string;
  replacement_revision_id: string;
  replacement_path: string;
  replacement_title: string;
  replacement_summary: string;
  body_object_key: string;
  body_size_bytes: number | string;
  body_content_hash: string;
  registration_id: string | null;
  registration_was_present: boolean | null;
  registration_name: string | null;
  state_mode: "none" | "existing" | "clone" | null;
  state_source_document_id: string | null;
  state_source_revision_id: string | null;
  state_replacement_document_id: string | null;
  state_replacement_revision_id: string | null;
  state_replacement_path: string | null;
  state_title: string | null;
  state_summary: string | null;
  state_body_object_key: string | null;
  state_body_size_bytes: number | string | null;
  state_body_content_hash: string | null;
  actor_subject: string;
  phase: "planned" | "applied" | "superseded";
};

type RegistrationRow = {
  id: string;
  key: string;
  name: string;
  instructions_document_id: string;
  state_document_id: string | null;
};

type PageSnapshot = {
  document_id: string;
  current_revision_id: string;
  current_path: string;
  version_number: number | string;
  next_version_number: number | string;
  title: string;
  summary: string;
  body_size_bytes: number | string;
  body_content_hash: string;
};

const REPLACEMENT_SELECT = `
  id,target_kind,target_key,source_document_id,source_revision_id,
  agents_occupant_document_id,agents_occupant_source_revision_id,
  agents_occupant_preservation_revision_id,
  agents_occupant_preservation_revision_number,
  agents_occupant_preservation_path,agents_occupant_preservation_title,
  agents_occupant_preservation_summary,
  agents_occupant_preservation_body_object_key,
  agents_occupant_preservation_body_size_bytes,
  agents_occupant_preservation_body_content_hash,
  replacement_document_id,replacement_revision_id,replacement_path,
  replacement_title,replacement_summary,body_object_key,body_size_bytes,
  body_content_hash,registration_id,registration_was_present,
  registration_name,state_mode,state_source_document_id,state_source_revision_id,
  state_replacement_document_id,state_replacement_revision_id,state_replacement_path,
  state_title,state_summary,state_body_object_key,state_body_size_bytes,
  state_body_content_hash,actor_subject,phase
`;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))].sort();
}

function assertManagedDocument(value: ManagedOperationalDocument): void {
  if (!value.title.trim() || value.title.length > 240 || /[\r\n]/.test(value.title)
      || !value.summary.trim() || value.summary.length > 320 || /[\r\n]/.test(value.summary)
      || !Number.isSafeInteger(value.body_size_bytes)
      || value.body_size_bytes < 0 || value.body_size_bytes > 4_000_000
      || !/^[a-f0-9]{64}$/.test(value.body_content_hash)) {
    throw new Error("Managed operational document metadata is invalid");
  }
}

function assertInput(input: BeginOperationalDocumentReplacementInput): void {
  assertManagedDocument(input.managed);
  if (!input.actor_subject.trim() || input.actor_subject.length > 512) {
    throw new Error("Managed operational document actor is invalid");
  }
  if (input.target.kind === "automation_instructions"
      && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.target.key)
        || !input.target.name.trim() || input.target.name.length > 160
        || (input.target.state?.mode === "existing"
          && input.target.state.document_id === input.source_document_id)
        || (input.target.state?.mode === "clone"
          && input.target.state.source_document_id === input.source_document_id))) {
    throw new Error("Managed automation replacement target is invalid");
  }
  if (input.target.kind === "automation_instructions"
      && input.target.state?.mode === "clone") {
    assertManagedDocument({
      title: input.target.state.title,
      summary: input.target.state.summary,
      body_size_bytes: input.target.state.body_size_bytes,
      body_content_hash: input.target.state.body_content_hash,
    });
  }
}

function plan(row: ReplacementRow): OperationalDocumentReplacementPlan {
  if (row.phase === "superseded") {
    throw new OperationalDocumentReplacementDriftError(row.id);
  }
  const state: OperationalDocumentReplacementPlan["state"] = row.state_mode === "existing"
    ? { mode: "existing", document_id: row.state_source_document_id! }
    : row.state_mode === "clone"
      ? {
        mode: "clone",
        source_document_id: row.state_source_document_id!,
        source_revision_id: row.state_source_revision_id!,
        replacement_document_id: row.state_replacement_document_id!,
        replacement_path: row.state_replacement_path!,
        replacement_revision: {
          revision_id: row.state_replacement_revision_id!,
          revision_number: 1,
          body_object_key: row.state_body_object_key!,
        },
        title: row.state_title!,
        summary: row.state_summary!,
        body_size_bytes: Number(row.state_body_size_bytes),
        body_content_hash: row.state_body_content_hash!,
      }
      : null;
  const target: OperationalDocumentReplacementTarget = row.target_kind === "global_guide"
    ? { kind: "global_guide" }
    : {
      kind: "automation_instructions",
      key: row.target_key!,
      name: row.registration_name!,
      state,
    };
  const agentsOccupantPreservation:
    OperationalDocumentReplacementPlan["agents_occupant_preservation"] =
    row.agents_occupant_document_id ? {
      document_id: row.agents_occupant_document_id,
      source_revision_id: row.agents_occupant_source_revision_id!,
      path: row.agents_occupant_preservation_path!,
      title: row.agents_occupant_preservation_title!,
      summary: row.agents_occupant_preservation_summary!,
      revision: {
        revision_id: row.agents_occupant_preservation_revision_id!,
        revision_number: Number(row.agents_occupant_preservation_revision_number),
        body_object_key: row.agents_occupant_preservation_body_object_key!,
      },
      body_size_bytes: Number(row.agents_occupant_preservation_body_size_bytes),
      body_content_hash: row.agents_occupant_preservation_body_content_hash!,
    } : null;
  return {
    replacement_id: row.id,
    phase: row.phase,
    target,
    source_document_id: row.source_document_id,
    source_revision_id: row.source_revision_id,
    replacement_document_id: row.replacement_document_id,
    replacement_path: row.replacement_path,
    replacement_revision: {
      revision_id: row.replacement_revision_id,
      revision_number: 1,
      body_object_key: row.body_object_key,
    },
    managed: {
      title: row.replacement_title,
      summary: row.replacement_summary,
      body_size_bytes: Number(row.body_size_bytes),
      body_content_hash: row.body_content_hash,
    },
    agents_occupant_preservation: agentsOccupantPreservation,
    registration_id: row.registration_id,
    state,
  };
}

function samePlan(
  row: ReplacementRow,
  input: BeginOperationalDocumentReplacementInput,
  registration: RegistrationRow | null,
  stateSourceRevisionId: string | null,
  agentsOccupant: PageSnapshot | null,
): boolean {
  return row.source_document_id === input.source_document_id
    && row.source_revision_id === input.source_revision_id
    && row.replacement_title === input.managed.title
    && row.replacement_summary === input.managed.summary
    && Number(row.body_size_bytes) === input.managed.body_size_bytes
    && row.body_content_hash === input.managed.body_content_hash
    && row.actor_subject === input.actor_subject
    && row.target_kind === input.target.kind
    && (input.target.kind === "global_guide"
      ? row.target_key === null && registration === null
        && row.agents_occupant_document_id === (agentsOccupant?.document_id ?? null)
        && row.agents_occupant_source_revision_id
          === (agentsOccupant?.current_revision_id ?? null)
        && row.agents_occupant_preservation_title === (agentsOccupant?.title ?? null)
        && row.agents_occupant_preservation_summary === (agentsOccupant?.summary ?? null)
        && Number(row.agents_occupant_preservation_revision_number)
          === Number(agentsOccupant?.next_version_number ?? 0)
        && Number(row.agents_occupant_preservation_body_size_bytes)
          === Number(agentsOccupant?.body_size_bytes ?? 0)
        && row.agents_occupant_preservation_body_content_hash
          === (agentsOccupant?.body_content_hash ?? null)
      : row.target_key === input.target.key
        && row.registration_id === (registration?.id ?? row.registration_id)
        && row.registration_was_present === Boolean(registration)
        && row.registration_name === (registration?.name ?? input.target.name)
        && row.state_mode === (input.target.state?.mode ?? "none")
        && row.state_source_document_id === (
          input.target.state?.mode === "existing"
            ? input.target.state.document_id
            : input.target.state?.mode === "clone"
              ? input.target.state.source_document_id
              : null
        )
        && row.state_source_revision_id === stateSourceRevisionId
        && (input.target.state?.mode !== "clone" || (
          row.state_source_revision_id === input.target.state.source_revision_id
          && row.state_title === input.target.state.title
          && row.state_summary === input.target.state.summary
          && Number(row.state_body_size_bytes) === input.target.state.body_size_bytes
          && row.state_body_content_hash === input.target.state.body_content_hash
        )));
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('filesystem-hypermedia-corpus-transition',0))",
    );
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class OperationalDocumentReplacementRepository {
  constructor(private readonly pool: Pool) {}

  async beginOrResume(
    input: BeginOperationalDocumentReplacementInput,
  ): Promise<OperationalDocumentReplacementPlan> {
    assertInput(input);
    return transaction(this.pool, async (client) => {
      const targetKey = input.target.kind === "global_guide"
        ? "global-guide"
        : `automation:${input.target.key}`;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('operational-replacement:'||$1,0))",
        [targetKey],
      );

      let registration: RegistrationRow | null = null;
      const stateSourceDocumentId = input.target.kind === "automation_instructions"
        ? input.target.state?.mode === "existing"
          ? input.target.state.document_id
          : input.target.state?.mode === "clone"
            ? input.target.state.source_document_id
            : null
        : null;
      let stateSourceRevisionId: string | null = null;
      for (const documentId of uniqueSorted([
        input.source_document_id,
        ...(stateSourceDocumentId ? [stateSourceDocumentId] : []),
      ])) {
        await client.query("SELECT lock_operational_document($1)", [documentId]);
      }

      const source = await client.query<PageSnapshot>(
        `SELECT page.id AS document_id,page.current_version_id AS current_revision_id,
           page.current_path,version.version_number,
           (SELECT coalesce(max(candidate.version_number),0)+1
            FROM knowledge_page_versions candidate
            WHERE candidate.page_id=page.id) AS next_version_number,
           version.title,version.summary,
           revision.body_size_bytes,revision.body_content_hash
         FROM knowledge_pages page
         JOIN knowledge_page_versions version
           ON version.id=page.current_version_id AND version.page_id=page.id
         JOIN hypermedia_documents document ON document.id=page.id
         JOIN hypermedia_document_revisions revision
           ON revision.id=page.current_version_id AND revision.document_id=page.id
         WHERE page.id=$1 AND page.current_version_id=$2 AND page.archived_at IS NULL
           AND document.authority='knowledge' AND document.representation='markdown'
         FOR UPDATE OF page`,
        [input.source_document_id, input.source_revision_id],
      );
      if (!source.rowCount) throw new OperationalDocumentReplacementDriftError(null);
      let agentsOccupant: PageSnapshot | null = null;

      if (input.target.kind === "global_guide") {
        const settings = await client.query(
          `SELECT 1 FROM knowledge_settings
           WHERE singleton AND global_guide_document_id=$1 FOR UPDATE`,
          [input.source_document_id],
        );
        if (!settings.rowCount) throw new OperationalDocumentReplacementDriftError(null);
        agentsOccupant = (await client.query<PageSnapshot>(
          `SELECT page.id AS document_id,page.current_version_id AS current_revision_id,
             page.current_path,version.version_number,
             (SELECT coalesce(max(candidate.version_number),0)+1
              FROM knowledge_page_versions candidate
              WHERE candidate.page_id=page.id) AS next_version_number,
             version.title,version.summary,
             revision.body_size_bytes,revision.body_content_hash
           FROM knowledge_pages page
           JOIN knowledge_page_versions version
             ON version.id=page.current_version_id AND version.page_id=page.id
           JOIN hypermedia_documents document ON document.id=page.id
           JOIN hypermedia_document_revisions revision
             ON revision.id=page.current_version_id AND revision.document_id=page.id
           WHERE page.current_path='agents' AND page.archived_at IS NULL
             AND document.authority='knowledge' AND document.representation='markdown'
           FOR UPDATE OF page`,
        )).rows[0] ?? null;
        if (agentsOccupant && (await client.query(
          `SELECT 1 FROM automation_registry
           WHERE instructions_document_id=$1 OR state_document_id=$1
           UNION ALL
           SELECT 1
           FROM corpus_migration_automation_plans plan
           JOIN corpus_migration_runs run ON run.id=plan.run_id
           WHERE run.phase='applying'
             AND (plan.instructions_document_id=$1 OR plan.state_document_id=$1)
           UNION ALL
           SELECT 1 FROM directory_hub_migrations WHERE document_id=$1
           LIMIT 1`,
          [agentsOccupant.document_id],
        )).rowCount) {
          throw new Error("The agents occupant is reserved by another operational role");
        }
        if (agentsOccupant && agentsOccupant.document_id !== input.source_document_id) {
          await client.query("SELECT lock_operational_document($1)", [
            agentsOccupant.document_id,
          ]);
          const stableOccupant = await client.query(
            `SELECT 1 FROM knowledge_pages
             WHERE id=$1 AND current_path='agents' AND current_version_id=$2
               AND archived_at IS NULL FOR UPDATE`,
            [agentsOccupant.document_id, agentsOccupant.current_revision_id],
          );
          if (!stableOccupant.rowCount) {
            throw new OperationalDocumentReplacementDriftError(null);
          }
        }
      } else {
        if (input.target.state?.mode === "existing") {
          const state = (await client.query<{ current_version_id: string }>(
            `SELECT page.current_version_id
             FROM knowledge_pages page
             JOIN hypermedia_documents document ON document.id=page.id
             WHERE page.id=$1 AND page.archived_at IS NULL
               AND page.published_version_id IS NULL AND page.public_path IS NULL
               AND document.authority='knowledge' AND document.representation='markdown'
             FOR UPDATE OF page`,
            [stateSourceDocumentId],
          )).rows[0];
          if (!state) throw new OperationalDocumentReplacementDriftError(null);
          stateSourceRevisionId = state.current_version_id;
        } else if (input.target.state?.mode === "clone") {
          const state = await client.query(
            `SELECT 1
             FROM knowledge_pages page
             JOIN knowledge_page_versions version
               ON version.id=page.current_version_id AND version.page_id=page.id
             JOIN hypermedia_document_revisions revision
               ON revision.id=version.id AND revision.document_id=page.id
             JOIN hypermedia_documents document ON document.id=page.id
             WHERE page.id=$1 AND page.current_version_id=$2 AND page.archived_at IS NULL
               AND version.title=$3 AND version.summary=$4
               AND revision.body_size_bytes=$5 AND revision.body_content_hash=$6
               AND document.authority='knowledge' AND document.representation='markdown'
             FOR UPDATE OF page`,
            [stateSourceDocumentId, input.target.state.source_revision_id,
              input.target.state.title, input.target.state.summary,
              input.target.state.body_size_bytes, input.target.state.body_content_hash],
          );
          if (!state.rowCount) throw new OperationalDocumentReplacementDriftError(null);
          stateSourceRevisionId = input.target.state.source_revision_id;
        }
        registration = (await client.query<RegistrationRow>(
          `SELECT id,key,name,instructions_document_id,state_document_id
           FROM automation_registry WHERE key=$1 FOR UPDATE`,
          [input.target.key],
        )).rows[0] ?? null;
        if (registration && (
          registration.instructions_document_id !== input.source_document_id
          || registration.state_document_id !== stateSourceDocumentId
        )) {
          throw new OperationalDocumentReplacementDriftError(null);
        }
        if (await client.query(
          `SELECT 1 FROM knowledge_settings
           WHERE singleton AND global_guide_document_id=$1`,
          [input.source_document_id],
        ).then(({ rowCount }) => Boolean(rowCount))) {
          throw new Error("The global guide cannot be replaced as automation instructions");
        }
      }

      const current = (await client.query<ReplacementRow>(
        `SELECT ${REPLACEMENT_SELECT}
         FROM operational_document_replacements
         WHERE target_kind=$1
           AND target_key IS NOT DISTINCT FROM $2
           AND phase='planned'
         FOR UPDATE`,
        [input.target.kind, input.target.kind === "global_guide" ? null : input.target.key],
      )).rows[0];
      if (current && samePlan(
        current,input,registration,stateSourceRevisionId,agentsOccupant,
      )) return plan(current);
      if (current) {
        await client.query(
          `UPDATE operational_document_replacements
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 AND phase='planned'`,
          [current.id],
        );
      }

      const replacementId = randomUUID();
      const documentId = randomUUID();
      const revisionId = randomUUID();
      const agentsOccupantPreservationRevisionId = agentsOccupant
        ? randomUUID()
        : null;
      const registrationId = input.target.kind === "automation_instructions"
        ? (registration?.id ?? randomUUID())
        : null;
      const stateReplacementDocumentId = input.target.kind === "automation_instructions"
        && input.target.state?.mode === "clone" ? randomUUID() : null;
      const stateReplacementRevisionId = stateReplacementDocumentId ? randomUUID() : null;
      const row = (await client.query<ReplacementRow>(
         `INSERT INTO operational_document_replacements(
           id,target_kind,target_key,source_document_id,source_revision_id,
           agents_occupant_document_id,agents_occupant_source_revision_id,
           agents_occupant_preservation_revision_id,
           agents_occupant_preservation_revision_number,
           agents_occupant_preservation_path,agents_occupant_preservation_title,
           agents_occupant_preservation_summary,
           agents_occupant_preservation_body_object_key,
           agents_occupant_preservation_body_size_bytes,
           agents_occupant_preservation_body_content_hash,
           replacement_document_id,replacement_revision_id,replacement_path,
           replacement_title,replacement_summary,body_object_key,body_size_bytes,
           body_content_hash,registration_id,registration_was_present,
           registration_name,state_mode,state_source_document_id,state_source_revision_id,
           state_replacement_document_id,state_replacement_revision_id,state_replacement_path,
           state_title,state_summary,state_body_object_key,state_body_size_bytes,
           state_body_content_hash,actor_subject
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
           $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
           $31,$32,$33,$34,$35,$36,$37,$38
         ) RETURNING ${REPLACEMENT_SELECT}`,
        [replacementId, input.target.kind,
          input.target.kind === "global_guide" ? null : input.target.key,
          input.source_document_id, input.source_revision_id,
          agentsOccupant?.document_id ?? null,
          agentsOccupant?.current_revision_id ?? null,
          agentsOccupantPreservationRevisionId,
          agentsOccupant ? Number(agentsOccupant.next_version_number) : null,
          agentsOccupant ? `preserved-agents-page-${documentId}` : null,
          agentsOccupant?.title ?? null,
          agentsOccupant?.summary ?? null,
          agentsOccupantPreservationRevisionId
            ? `documents/private/${agentsOccupantPreservationRevisionId}.md` : null,
          agentsOccupant ? Number(agentsOccupant.body_size_bytes) : null,
          agentsOccupant?.body_content_hash ?? null,
          documentId, revisionId, `managed-operational-${documentId}`,
          input.managed.title, input.managed.summary,
          `documents/private/${revisionId}.md`, input.managed.body_size_bytes,
          input.managed.body_content_hash, registrationId,
          input.target.kind === "automation_instructions" ? Boolean(registration) : null,
          input.target.kind === "automation_instructions"
            ? (registration?.name ?? input.target.name)
            : null,
          input.target.kind === "automation_instructions"
            ? (input.target.state?.mode ?? "none") : null,
          stateSourceDocumentId, stateSourceRevisionId,
          stateReplacementDocumentId, stateReplacementRevisionId,
          stateReplacementDocumentId ? `managed-operational-${stateReplacementDocumentId}` : null,
          input.target.kind === "automation_instructions"
            && input.target.state?.mode === "clone" ? input.target.state.title : null,
          input.target.kind === "automation_instructions"
            && input.target.state?.mode === "clone" ? input.target.state.summary : null,
          stateReplacementRevisionId ? `documents/private/${stateReplacementRevisionId}.md` : null,
          input.target.kind === "automation_instructions"
            && input.target.state?.mode === "clone" ? input.target.state.body_size_bytes : null,
          input.target.kind === "automation_instructions"
            && input.target.state?.mode === "clone" ? input.target.state.body_content_hash : null,
          input.actor_subject],
      )).rows[0]!;
      return plan(row);
    });
  }

  async apply(
    input: ApplyOperationalDocumentReplacementInput,
  ): Promise<OperationalDocumentReplacementPlan> {
    const bodyBytes = Buffer.from(input.body_markdown_for_index, "utf8");
    const submittedTargets = uniqueSorted(input.target_document_ids);
    if (JSON.stringify(submittedTargets)
        !== JSON.stringify(uniqueSorted(extractDocumentLinks(input.body_markdown_for_index)))) {
      throw new Error("Managed operational document link receipt does not match its Markdown");
    }
    const preservationBodyBytes = input.agents_occupant_preservation
      ? Buffer.from(input.agents_occupant_preservation.body_markdown_for_index, "utf8")
      : null;
    const preservationTargets = input.agents_occupant_preservation
      ? uniqueSorted(input.agents_occupant_preservation.target_document_ids)
      : [];
    if (input.agents_occupant_preservation && JSON.stringify(preservationTargets)
        !== JSON.stringify(uniqueSorted(extractDocumentLinks(
          input.agents_occupant_preservation.body_markdown_for_index,
        )))) {
      throw new Error("Preserved agents occupant link receipt does not match its Markdown");
    }
    const stateBodyBytes = input.state_clone
      ? Buffer.from(input.state_clone.body_markdown_for_index, "utf8")
      : null;
    const stateTargets = input.state_clone
      ? uniqueSorted(input.state_clone.target_document_ids)
      : [];
    if (input.state_clone && JSON.stringify(stateTargets) !== JSON.stringify(uniqueSorted(
      extractDocumentLinks(input.state_clone.body_markdown_for_index),
    ))) {
      throw new Error("Managed automation state clone link receipt does not match its Markdown");
    }

    const result = await transaction(this.pool, async (client) => {
      let row = (await client.query<ReplacementRow>(
        `SELECT ${REPLACEMENT_SELECT}
         FROM operational_document_replacements WHERE id=$1`,
        [input.replacement_id],
      )).rows[0];
      if (!row) throw new Error("Operational document replacement not found");
      await client.query("SELECT lock_corpus_migration_runs_for_operational_change()");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('operational-replacement:'||$1,0))",
        [row.target_kind === "global_guide" ? "global-guide" : `automation:${row.target_key}`],
      );
      for (const documentId of uniqueSorted([
        row.source_document_id,row.replacement_document_id,
        ...(row.agents_occupant_document_id ? [row.agents_occupant_document_id] : []),
        ...(row.state_source_document_id ? [row.state_source_document_id] : []),
        ...(row.state_replacement_document_id ? [row.state_replacement_document_id] : []),
      ])) {
        await client.query("SELECT lock_operational_document($1)", [documentId]);
      }
      row = (await client.query<ReplacementRow>(
        `SELECT ${REPLACEMENT_SELECT}
         FROM operational_document_replacements WHERE id=$1 FOR UPDATE`,
        [input.replacement_id],
      )).rows[0];
      if (!row) throw new Error("Operational document replacement not found");
      if (row.phase === "superseded") return { drifted: true as const, row };
      if (input.revision.id !== row.replacement_revision_id
          || input.revision.body_object_key !== row.body_object_key
          || input.revision.body_size_bytes !== Number(row.body_size_bytes)
          || input.revision.body_content_hash !== row.body_content_hash
          || bodyBytes.byteLength !== Number(row.body_size_bytes)
          || createHash("sha256").update(bodyBytes).digest("hex") !== row.body_content_hash) {
        throw new Error("Managed operational document object does not match its plan");
      }
      if (row.agents_occupant_document_id) {
        if (!input.agents_occupant_preservation || !preservationBodyBytes
            || input.agents_occupant_preservation.revision.id
              !== row.agents_occupant_preservation_revision_id
            || input.agents_occupant_preservation.revision.body_object_key
              !== row.agents_occupant_preservation_body_object_key
            || input.agents_occupant_preservation.revision.body_size_bytes
              !== Number(row.agents_occupant_preservation_body_size_bytes)
            || input.agents_occupant_preservation.revision.body_content_hash
              !== row.agents_occupant_preservation_body_content_hash
            || preservationBodyBytes.byteLength
              !== Number(row.agents_occupant_preservation_body_size_bytes)
            || createHash("sha256").update(preservationBodyBytes).digest("hex")
              !== row.agents_occupant_preservation_body_content_hash) {
          throw new Error("Preserved agents occupant object does not match its plan");
        }
      } else if (input.agents_occupant_preservation) {
        throw new Error("Agents occupant preservation was not planned");
      }
      if (row.state_mode === "clone") {
        if (!input.state_clone || !stateBodyBytes
            || input.state_clone.revision.id !== row.state_replacement_revision_id
            || input.state_clone.revision.body_object_key !== row.state_body_object_key
            || input.state_clone.revision.body_size_bytes !== Number(row.state_body_size_bytes)
            || input.state_clone.revision.body_content_hash !== row.state_body_content_hash
            || stateBodyBytes.byteLength !== Number(row.state_body_size_bytes)
            || createHash("sha256").update(stateBodyBytes).digest("hex")
              !== row.state_body_content_hash) {
          throw new Error("Managed automation state clone object does not match its plan");
        }
      } else if (input.state_clone) {
        throw new Error("Managed automation state clone was not planned");
      }
      if (submittedTargets.length > 100_000 || preservationTargets.length > 100_000
          || stateTargets.length > 100_000) {
        throw new Error("Managed operational document has too many links");
      }

      if (row.phase === "applied") {
        const applied = await client.query(
          `SELECT 1 FROM knowledge_pages page
           JOIN knowledge_page_versions version
             ON version.id=$3 AND version.page_id=page.id
           JOIN hypermedia_document_revisions revision
             ON revision.id=version.id AND revision.document_id=page.id
           WHERE page.id=$1 AND page.current_path=$2
             AND version.path=$2
             AND page.archived_at IS NULL AND page.published_version_id IS NULL
             AND page.public_path IS NULL AND revision.body_object_key=$4
             AND revision.body_size_bytes=$5 AND revision.body_content_hash=$6
             AND revision.links_indexed_at IS NOT NULL
             AND version.title=$7 AND version.summary=$8`,
          [row.replacement_document_id,
            row.target_kind === "global_guide" ? "agents" : row.replacement_path,
            row.replacement_revision_id, row.body_object_key,
            Number(row.body_size_bytes), row.body_content_hash,
            row.replacement_title,row.replacement_summary],
        );
        if (!applied.rowCount) throw new Error("Applied operational replacement is corrupt");
        if (row.agents_occupant_document_id && !(await client.query(
          `SELECT 1 FROM knowledge_pages page
           JOIN knowledge_page_versions version
             ON version.id=$3 AND version.page_id=page.id
           JOIN hypermedia_document_revisions revision
             ON revision.id=version.id AND revision.document_id=page.id
           WHERE page.id=$1
             AND version.version_number=$4 AND version.path=$2
             AND version.title=$5 AND version.summary=$6
             AND revision.body_object_key=$7 AND revision.body_size_bytes=$8
             AND revision.body_content_hash=$9 AND revision.links_indexed_at IS NOT NULL`,
          [row.agents_occupant_document_id,row.agents_occupant_preservation_path,
            row.agents_occupant_preservation_revision_id,
            Number(row.agents_occupant_preservation_revision_number),
            row.agents_occupant_preservation_title,
            row.agents_occupant_preservation_summary,
            row.agents_occupant_preservation_body_object_key,
            Number(row.agents_occupant_preservation_body_size_bytes),
            row.agents_occupant_preservation_body_content_hash],
        )).rowCount) {
          throw new Error("Applied agents occupant preservation is corrupt");
        }
        if (row.state_mode === "clone" && !(await client.query(
          `SELECT 1 FROM knowledge_pages page
           JOIN hypermedia_document_revisions revision
             ON revision.id=page.current_version_id AND revision.document_id=page.id
           WHERE page.id=$1 AND page.current_path=$2 AND page.current_version_id=$3
             AND page.archived_at IS NULL AND page.published_version_id IS NULL
             AND page.public_path IS NULL AND revision.body_object_key=$4
             AND revision.body_size_bytes=$5 AND revision.body_content_hash=$6`,
          [row.state_replacement_document_id, row.state_replacement_path,
            row.state_replacement_revision_id, row.state_body_object_key,
            Number(row.state_body_size_bytes), row.state_body_content_hash],
        )).rowCount) {
          throw new Error("Applied automation state clone is corrupt");
        }
        const targetStillApplied = row.target_kind === "global_guide"
          ? Boolean((await client.query(
            `SELECT 1 FROM knowledge_settings
             WHERE singleton AND global_guide_document_id=$1`,
            [row.replacement_document_id],
          )).rowCount)
          : Boolean((await client.query(
            `SELECT 1 FROM automation_registry
             WHERE id=$1 AND key=$2 AND instructions_document_id=$3
               AND state_document_id IS NOT DISTINCT FROM $4`,
            [row.registration_id, row.target_key, row.replacement_document_id,
              row.state_replacement_document_id ?? row.state_source_document_id],
          )).rowCount);
        if (!targetStillApplied) {
          throw new Error("Applied operational replacement no longer owns its target");
        }
        return { drifted: false as const, row };
      }

      if (row.target_kind === "global_guide") {
        await client.query("SELECT 1 FROM knowledge_settings WHERE singleton FOR UPDATE");
      } else {
        await client.query("SELECT lock_automation_registry_for_operational_retarget()");
      }
      const source = await client.query(
        `SELECT 1 FROM knowledge_pages
         WHERE id=$1 AND current_version_id=$2 AND archived_at IS NULL FOR UPDATE`,
        [row.source_document_id, row.source_revision_id],
      );
      const agentsOccupantMatches = row.target_kind !== "global_guide"
        ? true
        : row.agents_occupant_document_id
          ? Boolean((await client.query(
            `SELECT 1 FROM knowledge_pages
             WHERE id=$1 AND current_path='agents' AND current_version_id=$2
               AND archived_at IS NULL FOR UPDATE`,
            [row.agents_occupant_document_id,row.agents_occupant_source_revision_id],
          )).rowCount)
          : !(await client.query(
            `SELECT 1 FROM knowledge_pages
             WHERE current_path='agents' AND archived_at IS NULL FOR UPDATE`,
          )).rowCount;
      const agentsOccupantUnreserved = !row.agents_occupant_document_id || !(await client.query(
        `SELECT 1 FROM automation_registry
         WHERE instructions_document_id=$1 OR state_document_id=$1
         UNION ALL
         SELECT 1
         FROM corpus_migration_automation_plans plan
         JOIN corpus_migration_runs run ON run.id=plan.run_id
         WHERE run.phase='applying'
           AND (plan.instructions_document_id=$1 OR plan.state_document_id=$1)
         UNION ALL
         SELECT 1 FROM directory_hub_migrations WHERE document_id=$1
         LIMIT 1`,
        [row.agents_occupant_document_id],
      )).rowCount;
      let stateMatches = true;
      if (row.state_mode === "existing" || row.state_mode === "clone") {
        stateMatches = Boolean((await client.query(
          `SELECT 1 FROM knowledge_pages
           WHERE id=$1 AND current_version_id=$2 AND archived_at IS NULL
             AND ($3::boolean=false OR (published_version_id IS NULL AND public_path IS NULL))
           FOR UPDATE`,
          [row.state_source_document_id, row.state_source_revision_id,
            row.state_mode === "existing"],
        )).rowCount);
      }
      let targetMatches = false;
      if (source.rowCount && stateMatches && agentsOccupantMatches
          && agentsOccupantUnreserved
          && row.target_kind === "global_guide") {
        targetMatches = Boolean((await client.query(
          `SELECT 1 FROM knowledge_settings
           WHERE singleton AND global_guide_document_id=$1`,
          [row.source_document_id],
        )).rowCount);
      } else if (source.rowCount && stateMatches && row.registration_was_present) {
        targetMatches = Boolean((await client.query(
          `SELECT 1 FROM automation_registry
           WHERE id=$1 AND key=$2 AND instructions_document_id=$3
             AND state_document_id IS NOT DISTINCT FROM $4`,
          [row.registration_id, row.target_key, row.source_document_id,
            row.state_source_document_id],
        )).rowCount);
      } else if (source.rowCount && stateMatches) {
        targetMatches = !(await client.query(
          "SELECT 1 FROM automation_registry WHERE id=$1 OR key=$2",
          [row.registration_id, row.target_key],
        )).rowCount;
      }
      if (!targetMatches) {
        const superseded = (await client.query<ReplacementRow>(
          `UPDATE operational_document_replacements
           SET phase='superseded',updated_at=now(),superseded_at=now()
           WHERE id=$1 RETURNING ${REPLACEMENT_SELECT}`,
          [row.id],
        )).rows[0]!;
        return { drifted: true as const, row: superseded };
      }
      if (row.target_kind === "global_guide" && (await client.query(
        `SELECT 1 FROM knowledge_directories WHERE current_path='agents'
         UNION ALL
         SELECT 1 FROM assets WHERE current_path='agents' AND deleted_at IS NULL
         LIMIT 1`,
      )).rowCount) {
        throw new Error("The agents path is occupied by a non-page resource");
      }

      const collision = await client.query(
        `SELECT 1 FROM hypermedia_documents WHERE id=$1
         UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=$2
         UNION ALL SELECT 1 FROM knowledge_pages WHERE current_path=$3 AND archived_at IS NULL
         UNION ALL SELECT 1 FROM knowledge_directories WHERE current_path=$3
         UNION ALL SELECT 1 FROM assets WHERE current_path=$3 AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM hypermedia_documents WHERE id=$4
         UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=$5
         UNION ALL SELECT 1 FROM knowledge_pages WHERE current_path=$6 AND archived_at IS NULL
         UNION ALL SELECT 1 FROM knowledge_directories WHERE current_path=$6
         UNION ALL SELECT 1 FROM assets WHERE current_path=$6 AND deleted_at IS NULL
         UNION ALL SELECT 1 FROM hypermedia_document_revisions WHERE id=$7
         UNION ALL SELECT 1 FROM knowledge_pages WHERE current_path=$8 AND archived_at IS NULL
         UNION ALL SELECT 1 FROM knowledge_directories WHERE current_path=$8
         UNION ALL SELECT 1 FROM assets WHERE current_path=$8 AND deleted_at IS NULL
         LIMIT 1`,
        [row.replacement_document_id, row.replacement_revision_id, row.replacement_path,
          row.state_replacement_document_id, row.state_replacement_revision_id,
          row.state_replacement_path,row.agents_occupant_preservation_revision_id,
          row.agents_occupant_preservation_path],
      );
      if (collision.rowCount) throw new Error("Managed operational document identity collides");

      await client.query(
        "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
        [row.replacement_document_id],
      );
      await client.query(
        `INSERT INTO hypermedia_document_revisions(
           id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
         ) VALUES ($1,$2,1,$3,$4,$5)`,
        [row.replacement_revision_id, row.replacement_document_id,
          row.body_object_key, Number(row.body_size_bytes), row.body_content_hash],
      );
      if (row.target_kind !== "global_guide") {
        await client.query(
          `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
           VALUES ($1,$2,$3,page_search_vector($2,$4,$5,$6))`,
          [row.replacement_document_id, row.replacement_path,row.replacement_revision_id,
            row.replacement_title, row.replacement_summary, input.body_markdown_for_index],
        );
        await client.query(
          `INSERT INTO knowledge_page_versions(
             id,page_id,version_number,path,title,summary,
             commit_message,actor_kind,actor_subject
           ) VALUES ($1,$2,1,$3,$4,$5,$6,'dashboard',$7)`,
          [row.replacement_revision_id, row.replacement_document_id,row.replacement_path,
            row.replacement_title, row.replacement_summary,
            "Install managed operational document", row.actor_subject],
        );
        await client.query(
          "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
          [row.replacement_revision_id, submittedTargets],
        );
      }
      if (row.agents_occupant_document_id) {
        await client.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.agents_occupant_preservation_revision_id,
            row.agents_occupant_document_id,
            Number(row.agents_occupant_preservation_revision_number),
            row.agents_occupant_preservation_body_object_key,
            Number(row.agents_occupant_preservation_body_size_bytes),
            row.agents_occupant_preservation_body_content_hash],
        );
        await client.query(
          `INSERT INTO knowledge_page_versions(
             id,page_id,version_number,path,title,summary,
             commit_message,actor_kind,actor_subject
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'dashboard',$8)`,
          [row.agents_occupant_preservation_revision_id,
            row.agents_occupant_document_id,
            Number(row.agents_occupant_preservation_revision_number),
            row.agents_occupant_preservation_path,
            row.agents_occupant_preservation_title,
            row.agents_occupant_preservation_summary,
            "Preserve agents occupant before managed replacement",row.actor_subject],
        );
        await client.query(
          "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
          [row.agents_occupant_preservation_revision_id,preservationTargets],
        );
        await client.query(
          `UPDATE knowledge_pages
           SET search_vector=page_search_vector($2,$3,$4,$5),updated_at=now()
           WHERE id=$1 AND current_version_id=$6`,
          [row.agents_occupant_document_id,row.agents_occupant_preservation_path,
            row.agents_occupant_preservation_title,
            row.agents_occupant_preservation_summary,
            input.agents_occupant_preservation!.body_markdown_for_index,
            row.agents_occupant_source_revision_id],
        );
      }
      if (row.state_mode === "clone") {
        await client.query(
          "INSERT INTO hypermedia_documents(id,authority,representation) VALUES ($1,'knowledge','markdown')",
          [row.state_replacement_document_id],
        );
        await client.query(
          `INSERT INTO hypermedia_document_revisions(
             id,document_id,revision_number,body_object_key,body_size_bytes,body_content_hash
           ) VALUES ($1,$2,1,$3,$4,$5)`,
          [row.state_replacement_revision_id, row.state_replacement_document_id,
            row.state_body_object_key, Number(row.state_body_size_bytes), row.state_body_content_hash],
        );
        await client.query(
          `INSERT INTO knowledge_pages(id,current_path,current_version_id,search_vector)
           VALUES ($1,$2,$3,page_search_vector($2,$4,$5,$6))`,
          [row.state_replacement_document_id, row.state_replacement_path,
            row.state_replacement_revision_id, row.state_title, row.state_summary,
            input.state_clone!.body_markdown_for_index],
        );
        await client.query(
          `INSERT INTO knowledge_page_versions(
             id,page_id,version_number,path,title,summary,
             commit_message,actor_kind,actor_subject
           ) VALUES ($1,$2,1,$3,$4,$5,$6,'dashboard',$7)`,
          [row.state_replacement_revision_id, row.state_replacement_document_id,
            row.state_replacement_path, row.state_title, row.state_summary,
            "Clone managed automation state", row.actor_subject],
        );
        await client.query(
          "SELECT replace_knowledge_revision_projections($1,$2::uuid[])",
          [row.state_replacement_revision_id, stateTargets],
        );
      }
      const phase = (await client.query<{ phase: "applied" | "superseded" }>(
        `SELECT retarget_managed_operational_document(
           $1,$2,$3::uuid[]
         ) AS phase`,
        [row.id,input.body_markdown_for_index,submittedTargets],
      )).rows[0]?.phase;
      if (phase !== "applied") {
        throw new Error("Operational replacement target changed after its row lock");
      }
      const applied = (await client.query<ReplacementRow>(
        `SELECT ${REPLACEMENT_SELECT}
         FROM operational_document_replacements WHERE id=$1`,
        [row.id],
      )).rows[0]!;
      return { drifted: false as const, row: applied };
    });
    if (result.drifted) {
      throw new OperationalDocumentReplacementDriftError(result.row.id);
    }
    return plan(result.row);
  }
}
