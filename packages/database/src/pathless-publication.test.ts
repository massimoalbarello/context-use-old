import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import type { PathlessPublicationArtifactReceipt } from "@context-use/shared";
import {
  ConfirmationRepository,
  type PublicationConfirmationIntent,
} from "./confirmation.ts";
import {
  PathlessPublicEntrypointRepository,
  PathlessPublicRepository,
  PathlessPublicationAdoptionRepository,
  PathlessPublicationRepository,
  PathlessStoragePublicationRepository,
  type PathlessPublicationAdoption,
  type PathlessPublicationAdoptionArtifactReceipt,
  type PathlessPublicationAdoptionWriteAuthorization,
  type PathlessPublicationIntent,
  type PathlessPublicationWriteAuthorization,
  type PathlessStorageRoute,
} from "./pathless-publication.ts";

const documentId = "00000000-0000-4000-8000-000000000010";
const revisionId = "00000000-0000-4000-8000-000000000020";
const intentId = "00000000-0000-4000-8000-000000000030";
const publicId = "00000000-0000-4000-8000-000000000040";
const artifactId = "00000000-0000-4000-8000-000000000050";
const linkedPublicId = "00000000-0000-4000-8000-000000000060";
const adoptionId = "00000000-0000-4000-8000-000000000070";
const claimToken = "00000000-0000-4000-8000-000000000080";
const hash = (digit: string): string => digit.repeat(64);

type QueryCall = { sql: string; values: unknown[] | undefined };

function recordingPool(rows: unknown[] = []) {
  const calls: QueryCall[] = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rowCount: rows.length, rows };
    },
  } as unknown as Pool;
  return { calls, pool };
}

function recordingPoolSequence(rowSets: unknown[][]) {
  const calls: QueryCall[] = [];
  let index = 0;
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      const rows = rowSets[index++] ?? [];
      return { rowCount: rows.length, rows };
    },
  } as unknown as Pool;
  return { calls, pool };
}

describe("pathless publication dashboard boundary", () => {
  test("begins an exact page intent while leaving candidate allocation inside the database", async () => {
    const expiresAt = new Date("2026-08-23T12:05:00.000Z");
    const { calls, pool } = recordingPool([{
      id: intentId,
      action: "publish",
      target_kind: "page",
      target_document_id: documentId,
      expected_revision_id: revisionId,
      candidate_public_id: publicId,
      expires_at: expiresAt,
    }]);

    const intent = await new PathlessPublicationRepository(pool).begin({
      action: "publish",
      target_kind: "page",
      target_document_id: documentId,
      expected_revision_id: revisionId,
    }, { ownerUserId: "context-use-owner", sessionId: "session-1" });

    expect(intent).toMatchObject({ id: intentId, candidate_public_id: publicId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("FROM begin_pathless_publication_intent($1,$2,$3,$4,$5,$6,$7)");
    expect(calls[0]!.sql).not.toContain("candidate_artifact_id");
    expect(calls[0]!.sql).not.toContain("object_key");
    expect(calls[0]!.values?.slice(1)).toEqual([
      "publish",
      "page",
      documentId,
      revisionId,
      "context-use-owner",
      "session-1",
    ]);
    expect(calls[0]!.values?.[0]).toMatch(/^[a-f0-9-]{36}$/);
  });

  test("uses exact nulls for non-page-publication variants and cancels by principal", async () => {
    const { calls, pool } = recordingPool([{
      id: intentId,
      action: "unpublish",
      target_kind: "asset",
      target_document_id: documentId,
      expected_revision_id: null,
      candidate_public_id: null,
      expires_at: new Date(),
    }]);
    const publications = new PathlessPublicationRepository(pool);

    await publications.begin({
      action: "unpublish",
      target_kind: "asset",
      target_document_id: documentId,
    }, { ownerUserId: "context-use-owner", sessionId: "session-2" });
    await publications.cancel(intentId, {
      ownerUserId: "context-use-owner",
      sessionId: "session-2",
    });

    expect(calls[0]!.values?.[4]).toBeNull();
    expect(calls[1]).toEqual({
      sql: "SELECT cancel_pathless_publication_intent($1,$2,$3)",
      values: [intentId, "context-use-owner", "session-2"],
    });
  });

  test("reuses an explicit caller-stable intent UUID after a lost response", async () => {
    const row: PathlessPublicationIntent = {
      id: intentId,
      action: "publish",
      target_kind: "asset",
      target_document_id: documentId,
      expected_revision_id: null,
      candidate_public_id: publicId,
      expires_at: new Date(),
    };
    const { calls, pool } = recordingPool([row]);
    const publications = new PathlessPublicationRepository(pool);
    const input = {
      action: "publish" as const,
      target_kind: "asset" as const,
      target_document_id: documentId,
    };
    const principal = { ownerUserId: "context-use-owner", sessionId: "retry-session" };

    expect(await publications.begin(input, principal, intentId)).toEqual(row);
    expect(await publications.begin(input, principal, intentId)).toEqual(row);
    expect(calls.map(({ values }) => values?.[0])).toEqual([intentId, intentId]);
    expect(calls[0]!.values).toEqual(calls[1]!.values);
  });

  test("reads publication status through one exact dashboard-safe boundary", async () => {
    const status = {
      public_id: publicId,
      published_revision_id: revisionId,
      published_revision_number: 4,
      active: true,
    };
    const dashboard = recordingPool([status]);
    const publications = new PathlessPublicationRepository(dashboard.pool);

    expect(await publications.status("page", documentId)).toEqual(status);
    expect(dashboard.calls.at(-1)).toEqual({
      sql: expect.stringContaining("FROM get_pathless_dashboard_publication_status($1,$2)"),
      values: ["page", documentId],
    });
  });
});

describe("pathless publication storage boundary", () => {
  test("claims an exact write target without exposing a representation token", async () => {
    const target: PathlessPublicationWriteAuthorization = {
      intent_id: intentId,
      target_kind: "page",
      candidate_public_id: publicId,
      artifact_id: artifactId,
      source_body_object_key: `documents/private/${revisionId}.md`,
      source_body_size_bytes: "128",
      source_body_content_hash: hash("a"),
      body_object_key: `documents/public/${artifactId}.md`,
      max_body_size_bytes: "4000000",
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      public_filename: null,
      public_content_type: null,
      public_width: null,
      public_height: null,
      public_duration_seconds: null,
      projected_target_public_ids: [publicId, linkedPublicId].sort(),
      projection_receipt_hash: hash("b"),
      target_projection: [{
        target_document_id: documentId,
        outcome: "self",
        public_id: publicId,
        public_target_kind: "page",
      }],
    };
    const row = {
      claim_token: claimToken,
      finalized: false,
      artifact_id: artifactId,
      body_object_key: target.body_object_key,
      body_size_bytes: null,
      body_content_hash: null,
      authorization: target,
    };
    const { calls, pool } = recordingPool([row]);
    const storage = new PathlessStoragePublicationRepository(pool);

    expect(await storage.claimIntent(intentId, claimToken)).toEqual({
      claim_token: claimToken,
      finalized: false,
      artifact_id: artifactId,
      body_object_key: target.body_object_key,
      authorization: target,
    });
    expect(calls[0]!.sql).toContain("FROM claim_pathless_publication_artifact($1,$2)");
    expect(calls[0]!.sql).not.toContain("representation_token");
    expect(calls[0]!.values).toEqual([intentId, claimToken]);
  });

  test("finalizes every page receipt field under its claim token", async () => {
    const projected = [publicId, linkedPublicId].sort();
    const receipt = {
      intent_id: intentId,
      target_kind: "page",
      body_size_bytes: 128,
      body_content_hash: hash("a"),
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      projected_target_public_ids: projected,
      observed_public_uuid_tokens: projected,
      projection_receipt_hash: hash("b"),
    } satisfies PathlessPublicationArtifactReceipt;
    const { calls, pool } = recordingPool();

    await new PathlessStoragePublicationRepository(pool).finalizeIntent(claimToken, receipt);

    expect(calls[0]!.sql).toContain("finalize_pathless_publication_artifact_claim");
    expect(calls[0]!.sql).not.toContain("representation_token");
    expect(calls[0]!.values).toEqual([
      claimToken,
      intentId,
      "page",
      128,
      hash("a"),
      "Public title",
      "A concise public summary.",
      "2026-08-23T12:34:56.123456Z",
      null,
      null,
      null,
      null,
      null,
      projected,
      projected,
      hash("b"),
    ]);
  });

  test("forwards every asset field with exact empty projection receipts", async () => {
    const receipt = {
      intent_id: intentId,
      target_kind: "asset",
      body_size_bytes: 256,
      body_content_hash: hash("c"),
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: "1234567890.12345678901234567890",
    } satisfies PathlessPublicationArtifactReceipt;
    const { calls, pool } = recordingPool();

    await new PathlessStoragePublicationRepository(pool).finalizeIntent(claimToken, receipt);

    expect(calls[0]!.values).toEqual([
      claimToken,
      intentId,
      "asset",
      256,
      hash("c"),
      null,
      null,
      null,
      "portrait.jpg",
      "image/jpeg",
      1200,
      1500,
      "1234567890.12345678901234567890",
      [],
      [],
      null,
    ]);
  });

  test("resolves only one exact active representation token", async () => {
    const route: PathlessStorageRoute = {
      resource_kind: "page",
      representation_token: hash("d"),
      body_object_key: `documents/public/${artifactId}.md`,
      body_size_bytes: "128",
      body_content_hash: hash("a"),
    };
    const active = recordingPool([route]);
    expect(await new PathlessStoragePublicationRepository(active.pool).resolve(hash("d")))
      .toEqual(route);
    expect(active.calls[0]!.sql).toContain("FROM resolve_pathless_storage_route($1)");
    expect(active.calls[0]!.values).toEqual([hash("d")]);

    const inactive = recordingPool();
    expect(await new PathlessStoragePublicationRepository(inactive.pool).resolve(hash("e")))
      .toBeNull();

    const ambiguous = recordingPool([route, { ...route, resource_kind: "asset" }]);
    await expect(new PathlessStoragePublicationRepository(ambiguous.pool).resolve(hash("d")))
      .rejects.toThrow("resolves ambiguously");
  });
});

describe("pathless publication adoption boundary", () => {
  test("keeps corpus planning/apply separate from claimed storage materialization", async () => {
    const plan: PathlessPublicationAdoption = {
      id: adoptionId,
      adoption_kind: "legacy_asset",
      source_document_id: documentId,
      source_revision_id: null,
      public_id: publicId,
      candidate_artifact_id: artifactId,
      phase: "planned",
    };
    const entrypoint = { public_id: publicId, configured: true, active: true };
    const corpus = recordingPoolSequence([[plan], [{ phase: "applied" }], [entrypoint]]);
    const authorization: PathlessPublicationAdoptionWriteAuthorization = {
      adoption_id: adoptionId,
      adoption_kind: "legacy_asset",
      resource_kind: "asset",
      public_id: publicId,
      artifact_id: artifactId,
      source_body_object_key: `objects/${documentId}`,
      source_body_size_bytes: "256",
      source_body_content_hash: hash("c"),
      body_object_key: `artifacts/public/${artifactId}`,
      max_body_size_bytes: "5000000000",
      public_title: null,
      public_summary: null,
      public_last_edited_at: null,
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: "1234567890.12345678901234567890",
      projected_target_public_ids: [],
      projection_receipt_hash: hash("f"),
      target_projection: [],
    };
    const storage = recordingPoolSequence([[
      {
        claim_token: claimToken,
        finalized: false,
        artifact_id: artifactId,
        body_object_key: authorization.body_object_key,
        body_size_bytes: null,
        body_content_hash: null,
        authorization,
      },
    ], []]);
    const adoptions = new PathlessPublicationAdoptionRepository(corpus.pool);
    const materialization = new PathlessStoragePublicationRepository(storage.pool);

    expect(await adoptions.begin("legacy_asset", documentId, adoptionId)).toEqual(plan);
    expect(await materialization.claimAdoption(adoptionId, claimToken)).toMatchObject({
      claim_token: claimToken,
      finalized: false,
      authorization,
    });
    const receipt = {
      adoption_id: adoptionId,
      adoption_kind: "legacy_asset",
      body_size_bytes: 256,
      body_content_hash: hash("c"),
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: "1234567890.12345678901234567890",
      projection_receipt_hash: hash("f"),
    } satisfies PathlessPublicationAdoptionArtifactReceipt;
    await materialization.finalizeAdoption(claimToken, receipt);
    expect(await adoptions.apply(adoptionId)).toBe("applied");
    expect(await adoptions.seedEntrypoint()).toEqual(entrypoint);

    expect(corpus.calls[0]).toEqual({
      sql: expect.stringContaining("FROM begin_pathless_publication_adoption($1,$2,$3)"),
      values: [adoptionId, "legacy_asset", documentId],
    });
    expect(corpus.calls[1]).toEqual({
      sql: "SELECT apply_pathless_publication_adoption($1) AS phase",
      values: [adoptionId],
    });
    expect(corpus.calls[2]!.sql).toContain("FROM seed_pathless_publication_entrypoint()");
    expect(storage.calls[0]!.sql).toContain(
      "FROM claim_pathless_publication_adoption_artifact($1,$2)",
    );
    expect(storage.calls[0]!.sql).not.toContain("representation_token");
    expect(storage.calls[1]!.values).toEqual([
      claimToken,
      adoptionId,
      "legacy_asset",
      256,
      hash("c"),
      null,
      null,
      null,
      "portrait.jpg",
      "image/jpeg",
      1200,
      1500,
      "1234567890.12345678901234567890",
      [],
      [],
      hash("f"),
    ]);
  });

  test("uses adoption_id and forwards the complete directory-hub receipt", async () => {
    const projected = [publicId, linkedPublicId].sort();
    const storage = recordingPool();
    const materialization = new PathlessStoragePublicationRepository(storage.pool);
    const receipt = {
      adoption_id: adoptionId,
      adoption_kind: "directory_hub",
      body_size_bytes: 512,
      body_content_hash: hash("b"),
      public_title: "Directory hub",
      public_summary: "A promoted public directory hub.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      projected_target_public_ids: projected,
      observed_public_uuid_tokens: projected,
      projection_receipt_hash: hash("f"),
    } satisfies PathlessPublicationAdoptionArtifactReceipt;

    await materialization.finalizeAdoption(claimToken, receipt);

    expect(storage.calls[0]!.sql).toContain("finalize_pathless_publication_adoption_claim");
    expect(storage.calls[0]!.sql).not.toContain("intent_id");
    expect(storage.calls[0]!.values).toEqual([
      claimToken,
      adoptionId,
      "directory_hub",
      512,
      hash("b"),
      "Directory hub",
      "A promoted public directory hub.",
      "2026-08-23T12:34:56.123456Z",
      null,
      null,
      null,
      null,
      null,
      projected,
      projected,
      hash("f"),
    ]);
  });
});

describe("pathless publication entrypoint dashboard boundary", () => {
  test("gets, lists, and sets only safe pathless entrypoint fields", async () => {
    const state = { public_id: publicId, configured: true, active: true };
    const candidate = {
      public_id: publicId,
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      representation_token: hash("a"),
      body_object_key: "must-not-escape",
    };
    const dashboard = recordingPoolSequence([
      [{ ...state, source_document_id: documentId }],
      [candidate],
      [{ ...state, artifact_id: artifactId }],
    ]);
    const entrypoint = new PathlessPublicEntrypointRepository(dashboard.pool);

    expect(await entrypoint.get()).toEqual(state);
    expect(await entrypoint.candidates()).toEqual([{
      public_id: publicId,
      public_title: candidate.public_title,
      public_summary: candidate.public_summary,
      public_last_edited_at: candidate.public_last_edited_at,
      representation_token: candidate.representation_token,
    }]);
    expect(await entrypoint.set({ public_id: publicId })).toEqual(state);

    expect(dashboard.calls[0]!.sql).toContain("FROM get_pathless_publication_entrypoint()");
    expect(dashboard.calls[1]!.sql).toContain(
      "FROM list_pathless_publication_entrypoint_candidates()",
    );
    expect(dashboard.calls[2]).toEqual({
      sql: expect.stringContaining("FROM set_pathless_publication_entrypoint($1)"),
      values: [publicId],
    });
  });
});

describe("pathless public read boundary", () => {
  test("requires exactly one resolver state", async () => {
    const missing = new PathlessPublicRepository(recordingPool().pool);
    await expect(missing.resolve(`/p/${publicId}`)).rejects.toThrow(
      "did not resolve to exactly one state",
    );

    const state = {
      state: "inactive",
      route_kind: "page",
      canonical_path: null,
      public_id: null,
      representation_token: null,
      public_title: null,
      public_summary: null,
      public_last_edited_at: null,
      public_filename: null,
      public_content_type: null,
      public_width: null,
      public_height: null,
      public_duration_seconds: null,
    };
    const ambiguous = new PathlessPublicRepository(recordingPool([state, state]).pool);
    await expect(ambiguous.resolve(`/p/${publicId}`)).rejects.toThrow(
      "did not resolve to exactly one state",
    );
  });

  test("strips every identity and metadata field from inactive and unassigned routes", async () => {
    const leakyRows = [
      {
        state: "inactive",
        route_kind: "page",
        canonical_path: `/p/${publicId}`,
        public_id: publicId,
        representation_token: hash("a"),
        public_title: "Must not escape",
        public_summary: "Must not escape.",
        public_last_edited_at: "2026-08-23T12:34:56.123456Z",
        public_filename: null,
        public_content_type: null,
        public_width: null,
        public_height: null,
        public_duration_seconds: null,
        body_object_key: "must-not-escape",
      },
      {
        state: "unassigned",
        route_kind: "asset",
        canonical_path: `/a/${publicId}`,
        public_id: publicId,
        representation_token: hash("a"),
        public_title: null,
        public_summary: null,
        public_last_edited_at: null,
        public_filename: "must-not-escape.png",
        public_content_type: "image/png",
        public_width: 100,
        public_height: 100,
        public_duration_seconds: null,
      },
    ];
    const pool = recordingPoolSequence(leakyRows.map((row) => [row]));
    const publicData = new PathlessPublicRepository(pool.pool);

    expect(await publicData.resolve(`/p/${publicId}`)).toEqual({
      state: "inactive",
      route_kind: "page",
    });
    expect(await publicData.resolve(`/a/${publicId}`)).toEqual({
      state: "unassigned",
      route_kind: "asset",
    });
  });

  test("returns only safe active page/asset metadata and resolves the independent root", async () => {
    const activePage = {
      state: "active",
      route_kind: "markdown",
      canonical_path: `/p/${publicId}.md`,
      public_id: publicId,
      representation_token: hash("a"),
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      public_filename: null,
      public_content_type: null,
      public_width: null,
      public_height: null,
      public_duration_seconds: null,
      body_object_key: "must-not-escape",
    };
    const activeAsset = {
      state: "active",
      route_kind: "asset",
      canonical_path: `/a/${linkedPublicId}`,
      public_id: linkedPublicId,
      representation_token: hash("b"),
      public_title: null,
      public_summary: null,
      public_last_edited_at: null,
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: "1.2500",
      body_content_hash: "must-not-escape",
    };
    const root = { ...activePage, route_kind: "directory", canonical_path: `/p/${publicId}` };
    const pool = recordingPoolSequence([[activePage], [activeAsset], [root]]);
    const publicData = new PathlessPublicRepository(pool.pool);

    const page = await publicData.resolve(`/p/${publicId}.md`);
    const asset = await publicData.resolve(`/a/${linkedPublicId}`);
    const entrypoint = await publicData.entrypoint();
    expect(page).not.toHaveProperty("body_object_key");
    expect(asset).not.toHaveProperty("body_content_hash");
    expect(page).toMatchObject({ state: "active", route_kind: "markdown" });
    expect(asset).toMatchObject({ state: "active", public_duration_seconds: "1.2500" });
    expect(entrypoint).toMatchObject({ state: "active", route_kind: "directory" });
    expect(pool.calls[2]!.values).toEqual(["/p/"]);
  });

  test("lists active page and asset views with explicit sanitized columns", async () => {
    const page = {
      public_id: publicId,
      canonical_path: `/p/${publicId}`,
      markdown_path: `/p/${publicId}.md`,
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      representation_token: hash("a"),
      body_object_key: "must-not-escape",
    };
    const asset = {
      public_id: linkedPublicId,
      canonical_path: `/a/${linkedPublicId}`,
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: null,
      representation_token: hash("b"),
      source_document_id: documentId,
    };
    const pool = recordingPoolSequence([[page], [asset]]);
    const publicData = new PathlessPublicRepository(pool.pool);

    expect(await publicData.pages()).toEqual([{
      public_id: publicId,
      canonical_path: `/p/${publicId}`,
      markdown_path: `/p/${publicId}.md`,
      public_title: "Public title",
      public_summary: "A concise public summary.",
      public_last_edited_at: "2026-08-23T12:34:56.123456Z",
      representation_token: hash("a"),
    }]);
    expect(await publicData.assets()).toEqual([{
      public_id: linkedPublicId,
      canonical_path: `/a/${linkedPublicId}`,
      public_filename: "portrait.jpg",
      public_content_type: "image/jpeg",
      public_width: 1200,
      public_height: 1500,
      public_duration_seconds: null,
      representation_token: hash("b"),
    }]);
    expect(pool.calls[0]!.sql).not.toContain("object_key");
    expect(pool.calls[1]!.sql).not.toContain("source_document_id");
  });
});

describe("publication confirmation family dispatch", () => {
  test("normalizes pathless confirmation intent fields without publication evidence", async () => {
    const pathlessIntent: PublicationConfirmationIntent = {
      intent_store: "pathless",
      id: intentId,
      action: "publish",
      target_kind: "page",
      target_id: documentId,
      version_id: revisionId,
      public_path: null,
      owner_user_id: "context-use-owner",
      session_id: "session-1",
      challenge: "challenge",
      expires_at: new Date("2026-08-23T12:05:00.000Z"),
    };
    const { calls, pool } = recordingPool([{
      reserved_store: "pathless",
      ...pathlessIntent,
    }]);

    expect(await new ConfirmationRepository(pool).publicationIntent(intentId))
      .toEqual(pathlessIntent);
    expect(calls[0]!.sql).toContain("UNION ALL");
    expect(calls[0]!.sql).toContain("FROM publication_intent_id_reservations");
    expect(calls[0]!.sql).toContain("FULL JOIN intent ON true");
    expect(calls[0]!.sql).toContain("pathless.target_document_id AS target_id");
    expect(calls[0]!.sql).toContain("pathless.expected_revision_id AS version_id");
    expect(calls[0]!.sql).not.toContain("candidate_public_id");
    expect(calls[0]!.sql).not.toContain("candidate_artifact_id");
    expect(calls[0]!.sql).not.toContain("object_key");
    expect(calls[0]!.values).toEqual([intentId]);
  });

  test("keeps the unified confirmation procedure and legacy normalized shape", async () => {
    const legacyIntent: PublicationConfirmationIntent = {
      intent_store: "legacy",
      id: intentId,
      action: "unpublish",
      target_kind: "asset",
      target_id: documentId,
      version_id: null,
      public_path: "media/portrait",
      owner_user_id: "context-use-owner",
      session_id: "session-legacy",
      challenge: "challenge",
      expires_at: new Date("2026-08-23T12:05:00.000Z"),
    };
    const { calls, pool } = recordingPool([{
      reserved_store: "legacy",
      ...legacyIntent,
    }]);
    const confirmations = new ConfirmationRepository(pool);

    expect(await confirmations.publicationIntent(intentId)).toEqual(legacyIntent);
    await confirmations.confirmPublication(intentId, {
      ownerUserId: "context-use-owner",
      sessionId: "session-legacy",
    }, { credentialId: "credential", expectedCounter: 4, newCounter: 5 });

    expect(calls[1]).toEqual({
      sql: "SELECT confirm_publication_intent($1,$2,$3,$4,$5,$6)",
      values: [intentId, "context-use-owner", "session-legacy", "credential", 4, 5],
    });
  });

  test("fails closed on ambiguous or reservation-mismatched publication families", async () => {
    const candidate = {
      id: intentId,
      action: "publish",
      target_kind: "page",
      target_id: documentId,
      version_id: revisionId,
      public_path: null,
      owner_user_id: "context-use-owner",
      session_id: "session-1",
      challenge: null,
      expires_at: new Date(),
    };
    const ambiguous = recordingPool([
      { reserved_store: "legacy", intent_store: "legacy", ...candidate },
      { reserved_store: "legacy", intent_store: "pathless", ...candidate },
    ]);
    await expect(new ConfirmationRepository(ambiguous.pool).publicationIntent(intentId))
      .rejects.toThrow("ambiguous family");

    const mismatched = recordingPool([{
      reserved_store: "legacy",
      intent_store: "pathless",
      ...candidate,
    }]);
    await expect(new ConfirmationRepository(mismatched.pool).publicationIntent(intentId))
      .rejects.toThrow("does not match its reservation");

    const unreserved = recordingPool([{
      reserved_store: null,
      intent_store: "pathless",
      ...candidate,
    }]);
    await expect(new ConfirmationRepository(unreserved.pool).publicationIntent(intentId))
      .rejects.toThrow("does not match its reservation");
  });

  test("returns null only for an absent UUID or a legacy tombstone", async () => {
    const absent = recordingPool();
    expect(await new ConfirmationRepository(absent.pool).publicationIntent(intentId)).toBeNull();

    const tombstone = recordingPool([{
      reserved_store: "legacy",
      intent_store: null,
      id: null,
    }]);
    expect(await new ConfirmationRepository(tombstone.pool).publicationIntent(intentId)).toBeNull();

    const missingPathless = recordingPool([{
      reserved_store: "pathless",
      intent_store: null,
      id: null,
    }]);
    await expect(new ConfirmationRepository(missingPathless.pool).publicationIntent(intentId))
      .rejects.toThrow("has no live family");
  });
});
