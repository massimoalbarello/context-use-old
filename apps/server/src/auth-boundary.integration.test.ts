import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { makeSignature } from "better-auth/crypto";
import { Client, Pool } from "pg";
import {
  DocumentAssetRepository,
  StoragePublicationRepository,
} from "@context-use/database";
import { disposableDatabaseUrl } from "@context-use/database/disposable-database";
import { config } from "./config.ts";
import { csrfToken } from "./security.ts";
import { createStorageBrokerApp } from "./storage-app.ts";
import { MemoryObjectStorage } from "./test-object-storage.ts";

const databaseUrl = await disposableDatabaseUrl();
const requireDatabase = (): string => {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  return databaseUrl;
};
// This suite imports every application boundary into one Bun process and installs
// a process-global storage handler. Run it as its own CI process so unrelated
// integration modules cannot retain or replace that handler while these tests are
// exercising the real cross-service boundary.
const enabled = process.env.TEST_APP_DATABASE_URL === "1"
  && process.env.TEST_AUTH_BOUNDARY_ISOLATED === "1";
const testStoragePool = enabled ? new Pool({ connectionString: config.STORAGE_DATABASE_URL }) : null;
const testStorage = enabled ? new MemoryObjectStorage() : null;
if (enabled) {
  const storageBroker = createStorageBrokerApp({
    storage: testStorage!,
    privateAssets: new DocumentAssetRepository(testStoragePool!),
    publications: new StoragePublicationRepository(testStoragePool!),
    tokens: {
      dashboard: config.STORAGE_DASHBOARD_TOKEN,
      mcp: config.STORAGE_MCP_TOKEN,
      public: config.STORAGE_PUBLIC_TOKEN,
    },
  });
  (globalThis as typeof globalThis & {
    __contextUseStorageHandler?: (request: Request) => Promise<Response> | Response;
  }).__contextUseStorageHandler = (request) => storageBroker.handle(request);
}
const application = enabled ? (await import("./combined-app.ts")).combinedApp : null;
const authentication = enabled ? (await import("./auth-app.ts")).authApp : null;
const confirmation = enabled ? (await import("./confirmation-app.ts")).confirmationApp : null;
const describeApplication = enabled ? describe : describe.skip;
const createdClients: string[] = [];

describeApplication("HTTP credential and OAuth boundary", () => {
  afterAll(async () => {
    if (!databaseUrl) return;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    for (const clientId of createdClients) await client.query(`DELETE FROM "oauthClient" WHERE "clientId"=$1`, [clientId]);
    await client.end();
    delete (globalThis as typeof globalThis & {
      __contextUseStorageHandler?: (request: Request) => Promise<Response> | Response;
    }).__contextUseStorageHandler;
    await testStoragePool?.end();
  });

  test("bearer credentials are rejected by publication APIs", async () => {
    const confirm = await application!.handle(new Request("http://localhost:3000/api/dashboard/publications/confirm", {
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: "{}",
    }));
    expect(confirm.status).toBe(401);

    for (const [path, method] of [
      ["/api/dashboard/publication-intents", "POST"],
      ["/api/dashboard/publication-intents/11111111-1111-4111-8111-111111111111", "DELETE"],
      ["/api/dashboard/publication-entrypoint", "GET"],
      ["/api/dashboard/publication-entrypoint/candidates", "GET"],
      ["/api/dashboard/publication-entrypoint", "PUT"],
      ["/api/dashboard/knowledge-documents/11111111-1111-4111-8111-111111111111/publication-preview", "GET"],
    ] as const) {
      const canonical = await application!.handle(new Request(`http://localhost:3000${path}`, {
        method,
        headers: { authorization: "Bearer forged", "content-type": "application/json" },
        ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
      }));
      expect(canonical.status).toBe(401);
    }
  });

  test("bearer and anonymous credentials cannot reach knowledge export APIs", async () => {
    const intent = await application!.handle(new Request("http://localhost:3000/api/dashboard/knowledge-export-intents", {
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: "{}",
    }));
    expect(intent.status).toBe(401);
    const download = await application!.handle(new Request(
      "http://localhost:3000/api/dashboard/knowledge-exports/11111111-1111-4111-8111-111111111111/download",
      { headers: { "sec-fetch-site": "same-origin" } },
    ));
    expect(download.status).toBe(401);
    const status = await application!.handle(new Request(
      "http://localhost:3000/api/dashboard/knowledge-exports/11111111-1111-4111-8111-111111111111/status",
    ));
    expect(status.status).toBe(401);
    const confirm = await application!.handle(new Request("http://localhost:3000/api/dashboard/knowledge-exports/confirm", {
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: "{}",
    }));
    expect(confirm.status).toBe(401);
    for (const [path, method] of [
      ["/api/dashboard/knowledge-bundle-export-intents", "POST"],
      ["/api/dashboard/knowledge-bundles/11111111-1111-4111-8111-111111111111/status", "GET"],
      ["/api/dashboard/knowledge-bundles/11111111-1111-4111-8111-111111111111/download", "GET"],
      ["/api/dashboard/knowledge-imports", "POST"],
      ["/api/dashboard/knowledge-imports/11111111-1111-4111-8111-111111111111/status", "GET"],
      ["/api/dashboard/knowledge-imports/confirm", "POST"],
    ] as const) {
      const response = await application!.handle(new Request(`http://localhost:3000${path}`, {
        method,
        headers: { authorization: "Bearer forged", "content-type": "application/json",
          ...(path.endsWith("/download") ? { "sec-fetch-site": "same-origin" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      }));
      expect(response.status).toBe(401);
    }
  });

  test("bearer credentials cannot create or confirm permanent page deletions", async () => {
    const intent = await application!.handle(new Request(
      "http://localhost:3000/api/dashboard/knowledge-documents/11111111-1111-4111-8111-111111111111/deletion-intents",
      {
        method: "POST",
        headers: { authorization: "Bearer forged", "content-type": "application/json" },
        body: "{}",
      },
    ));
    expect(intent.status).toBe(401);

    const confirm = await application!.handle(new Request("http://localhost:3000/api/dashboard/page-deletions/confirm", {
      method: "POST",
      headers: { authorization: "Bearer forged", "content-type": "application/json" },
      body: "{}",
    }));
    expect(confirm.status).toBe(401);
  });

  test("passkey management is reachable only from an authenticated dashboard session", async () => {
    for (const [path, body] of [
      ["/api/dashboard/passkey-enrollment-intents", { name: "Attacker key", authenticator_attachment: null }],
      ["/api/dashboard/passkey-enrollment-intents/11111111-1111-4111-8111-111111111111/confirm", { response: {} }],
      ["/api/dashboard/passkeys/attacker/removal-intents", {}],
      ["/api/dashboard/passkeys/attacker/remove", {
        intent_id: "11111111-1111-4111-8111-111111111111",
        response: {},
      }],
    ] as const) {
      for (const headers of [{}, { authorization: "Bearer forged" }]) {
        const response = await application!.handle(new Request(`http://localhost:3000${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        }));
        expect(response.status).toBe(401);
      }
    }
  });

  test("confirmation browser handlers are internal and require the auth gateway capability", async () => {
    const response = await confirmation!.handle(new Request(
      "http://confirmation:3004/internal/browser-confirmation/publication",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principal: { owner_user_id: "context-use-owner", session_id: "forged" },
          confirmation: {
            intent_id: "11111111-1111-4111-8111-111111111111",
            response: {},
          },
        }),
      },
    ));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("gateway");

    const deletion = await confirmation!.handle(new Request(
      "http://confirmation:3004/internal/browser-confirmation/page_deletion",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principal: { owner_user_id: "context-use-owner", session_id: "forged" },
          confirmation: {
            intent_id: "11111111-1111-4111-8111-111111111111",
            response: {},
          },
        }),
      },
    ));
    expect(deletion.status).toBe(404);
  });

  test("every non-browser internal endpoint requires its pairwise service capability", async () => {
    const authResponse = await authentication!.handle(new Request(
      "http://auth:3002/internal/authorize-dashboard",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          pathname: "/api/dashboard/documents",
          kind: "read",
          headers: {},
        }),
      },
    ));
    expect(authResponse.status).toBe(404);
    const nangoResponse = await authentication!.handle(new Request(
      "http://auth:3002/internal/authorize-nango",
      { headers: { authorization: "Bearer forged" } },
    ));
    expect(nangoResponse.status).toBe(404);
    const mcpResponse = await authentication!.handle(new Request(
      "http://auth:3002/internal/authorize-mcp",
      { headers: { authorization: "Bearer forged" } },
    ));
    expect(mcpResponse.status).toBe(404);
    const jwksWithoutCapability = await authentication!.handle(new Request(
      "http://auth:3002/internal/jwks",
    ));
    expect(jwksWithoutCapability.status).toBe(404);

    const confirmationResponse = await confirmation!.handle(new Request(
      "http://confirmation:3004/internal/confirmation/publication/11111111-1111-4111-8111-111111111111/options",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    expect(confirmationResponse.status).toBe(404);
  });

  test("cookie credentials are rejected by MCP with discovery metadata", async () => {
    const response = await application!.handle(new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: { cookie: "context-use.session_token=forged", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
  });

  test("MCP transport methods always use the private MCP boundary", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await application!.handle(new Request("http://localhost:3000/mcp", { method }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    }
  });

  test("protected-resource discovery advertises only the knowledge resource", async () => {
    for (const [path, resource, resourceName] of [
      ["/.well-known/oauth-protected-resource", "http://localhost:3000/mcp", "context-use personal knowledge base"],
      ["/.well-known/oauth-protected-resource/mcp", "http://localhost:3000/mcp", "context-use personal knowledge base"],
    ] as const) {
      const response = await application!.handle(new Request(`http://localhost:3000${path}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource,
        resource_name: resourceName,
        // Clients register with what they read here, so the refresh-token scope has to
        // be discoverable or their authorization request is rejected for asking.
        scopes_supported: ["mcp:access", "offline_access"],
      });
    }
    expect((await application!.handle(new Request(
      "http://localhost:3000/.well-known/oauth-protected-resource/mcp/execution",
    ))).status).toBe(404);
    expect((await application!.handle(new Request(
      "http://localhost:3000/mcp/execution",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ))).status).toBe(404);
  });

  test("private asset access requires a dashboard session on the dashboard origin", async () => {
    for (const path of [
      "/api/dashboard/documents",
      "/api/dashboard/documents/11111111-1111-4111-8111-111111111111",
      "/api/dashboard/documents/11111111-1111-4111-8111-111111111111/neighborhood",
      "/api/dashboard/source-records/11111111-1111-4111-8111-111111111111",
      "/api/dashboard/knowledge-documents/11111111-1111-4111-8111-111111111111",
      "/api/dashboard/knowledge-documents/11111111-1111-4111-8111-111111111111/history",
    ]) {
      const dashboard = await application!.handle(new Request(`http://localhost:3000${path}`));
      expect(dashboard.status).toBe(401);
    }
    for (const headers of [{}, { authorization: "Bearer forged" }]) {
      const privateAsset = await application!.handle(new Request(
        "http://localhost:3000/api/dashboard/assets/11111111-1111-4111-8111-111111111111/content",
        { headers },
      ));
      expect(privateAsset.status).toBe(401);
    }
    const wrongOrigin = await application!.handle(new Request(
      "http://assets.localhost:3000/api/dashboard/assets/11111111-1111-4111-8111-111111111111/content",
    ));
    expect(wrongOrigin.status).toBe(404);
  });

  test("malformed public identifiers are indistinguishable", async () => {
    const malformedPage = await application!.handle(new Request("http://localhost:3000/p/INVALID"));
    const missingPage = await application!.handle(new Request("http://localhost:3000/p/missing-page"));
    expect(malformedPage.status).toBe(404);
    expect(missingPage.status).toBe(404);
    expect(await malformedPage.text()).toBe(await missingPage.text());
  });

  test("an unconfigured legacy introduction path has no special public state", async () => {
    const response = await application!.handle(new Request("http://localhost:3000/p/about/intro"));
    expect(response.status).toBe(404);
  });


  test("an active canonical page is served only through its current representation token", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    const pageId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const publicId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    const retainedSourceId = crypto.randomUUID();
    const representationToken = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`canonical-route:${artifactId}`),
    )).toString("hex");
    const body = "PUBLIC-PAGE-CANARY\n\n[Follow another public page](/p/11111111-1111-4111-8111-111111111111).";
    const bodyHash = Buffer.from(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    )).toString("hex");
    const objectKey = `documents/public/${artifactId}.md`;
    const retainedAlias = `/p/retained-${publicId.slice(0, 8)}`;
    let previousEntrypoint: { entrypoint_public_id: string | null; updated_at: Date | null } | undefined;
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      previousEntrypoint = (await client.query<{
        entrypoint_public_id: string | null;
        updated_at: Date | null;
      }>(
        `SELECT entrypoint_public_id,updated_at
         FROM publication_settings WHERE singleton`,
      )).rows[0];
      await client.query(
        "INSERT INTO knowledge_pages(id,current_version_id) VALUES ($1,$2)",
        [pageId, revisionId],
      );
      await client.query(
        `INSERT INTO public_resources(public_id,document_id,original_document_id,resource_kind)
         VALUES ($1,$2,$2,'page')`,
        [publicId, pageId],
      );
      await client.query(
        "INSERT INTO public_visibility_generations(public_id,generation) VALUES ($1,1)",
        [publicId],
      );
      await client.query(
        `INSERT INTO publication_target_generations(target_kind,target_document_id,generation)
         VALUES ('page',$1,1)`,
        [pageId],
      );
      await client.query(
        `INSERT INTO public_artifact_id_reservations(
           artifact_id,body_object_key,allocation_kind,allocation_id
         ) VALUES ($1,$2,'retained_publication',$3)`,
        [artifactId, objectKey, retainedSourceId],
      );
      await client.query(
        `INSERT INTO public_representation_token_reservations(
           representation_token,artifact_id,resource_kind
         ) VALUES ($1,$2,'page')`,
        [representationToken, artifactId],
      );
      await client.query(
        `INSERT INTO public_page_artifacts(
           artifact_id,public_id,source_document_id,source_revision_id,
           source_body_size_bytes,source_body_content_hash,body_object_key,
           body_size_bytes,body_content_hash,public_title,public_summary,
           public_last_edited_at,projection_receipt_hash,origin,
           retained_source_id,retained_source_kind,retained_source_artifact_id,
           retained_projection_generation,representation_token,
           reservation_allocation_kind,reservation_allocation_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$5,$6,'Canonical route',
           'A page identified only by its stable UUID.','2026-08-23 12:34:56.123456+00',$8,
           'retained',$9,'page',$10,1,$11,'retained_publication',$9
         )`,
        [
          artifactId,
          publicId,
          pageId,
          revisionId,
          Buffer.byteLength(body),
          bodyHash,
          objectKey,
          "c".repeat(64),
          retainedSourceId,
          crypto.randomUUID(),
          representationToken,
        ],
      );
      await client.query(
        "INSERT INTO page_publications(public_id,artifact_id) VALUES ($1,$2)",
        [publicId, artifactId],
      );
      await client.query(
        `INSERT INTO public_route_aliases(alias_path,route_kind,public_id)
         VALUES ($1,'page',$2)`,
        [retainedAlias, publicId],
      );
      await client.query(
        `UPDATE publication_settings
         SET entrypoint_public_id=$1,updated_at=now() WHERE singleton`,
        [publicId],
      );
      await client.query("COMMIT");
      await testStorage!.write({
        id: artifactId,
        objectKey,
        filename: `${artifactId}.md`,
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: Buffer.byteLength(body),
        contentHash: bodyHash,
      }, new Blob([body]).stream());

      const html = await application!.handle(new Request(`http://localhost:3000/p/${publicId}`));
      const markdown = await application!.handle(new Request(`http://localhost:3000/p/${publicId}.md`));
      expect(html.status).toBe(200);
      const htmlText = await html.text();
      expect(htmlText).toContain("PUBLIC-PAGE-CANARY");
      expect(htmlText).not.toContain(representationToken);
      expect(htmlText).not.toContain(objectKey);
      expect(markdown.status).toBe(200);
      expect(await markdown.text()).toContain("A page identified only by its stable UUID.");
      expect(markdown.headers.get("link")).toBe(
        `<${config.APP_ORIGIN}/p/${publicId}>; rel="canonical"`,
      );
      const aliased = await application!.handle(new Request(`http://localhost:3000${retainedAlias}`));
      expect(aliased.status).toBe(200);
      expect(await aliased.text()).toContain("PUBLIC-PAGE-CANARY");
      const entrypoint = await application!.handle(new Request("http://localhost:3000/p/"));
      expect(entrypoint.status).toBe(302);
      expect(entrypoint.headers.get("location")).toBe(`/p/${publicId}`);
      const llms = await application!.handle(new Request("http://localhost:3000/llms.txt"));
      expect(await llms.text()).toContain(`${config.APP_ORIGIN}/p/${publicId}.md`);
      const sitemap = await application!.handle(new Request("http://localhost:3000/sitemap.xml"));
      expect(await sitemap.text()).toContain(`<loc>${config.APP_ORIGIN}/p/${publicId}</loc>`);
      const landing = await application!.handle(new Request("http://localhost:3000/"));
      expect(await landing.text()).toContain("A page identified only by its stable UUID.");

      await client.query("DELETE FROM page_publications WHERE public_id=$1", [publicId]);
      expect((await application!.handle(new Request(`http://localhost:3000/p/${publicId}`))).status).toBe(404);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("BEGIN").catch(() => undefined);
      await client.query("SET LOCAL session_replication_role=replica").catch(() => undefined);
      if (previousEntrypoint) {
        await client.query(
          `UPDATE publication_settings
           SET entrypoint_public_id=$1,updated_at=$2 WHERE singleton`,
          [previousEntrypoint.entrypoint_public_id, previousEntrypoint.updated_at],
        ).catch(() => undefined);
      }
      await client.query("DELETE FROM page_publications WHERE public_id=$1", [publicId]).catch(() => undefined);
      await client.query("DELETE FROM public_page_artifacts WHERE artifact_id=$1", [artifactId]).catch(() => undefined);
      await client.query(
        "DELETE FROM public_representation_token_reservations WHERE representation_token=$1",
        [representationToken],
      ).catch(() => undefined);
      await client.query("DELETE FROM public_artifact_id_reservations WHERE artifact_id=$1", [artifactId]).catch(() => undefined);
      await client.query("DELETE FROM public_route_aliases WHERE alias_path=$1", [retainedAlias]).catch(() => undefined);
      await client.query("DELETE FROM public_visibility_generations WHERE public_id=$1", [publicId]).catch(() => undefined);
      await client.query("DELETE FROM public_resources WHERE public_id=$1", [publicId]).catch(() => undefined);
      await client.query(
        "DELETE FROM publication_target_generations WHERE target_kind='page' AND target_document_id=$1",
        [pageId],
      ).catch(() => undefined);
      await client.query("DELETE FROM knowledge_pages WHERE id=$1", [pageId]).catch(() => undefined);
      await client.query("COMMIT").catch(() => undefined);
      await client.end().catch(() => undefined);
      await testStorage!.delete(objectKey).catch(() => undefined);
    }
  }, 15_000);

  test("audit history endpoint is absent", async () => {
    const response = await application!.handle(new Request("http://localhost:3000/api/dashboard/audit"));
    expect(response.status).toBe(404);
  });

  test("owner enrollment requires the configured email and setup capability", async () => {
    const invalid = new URL("http://localhost:3000/api/auth/passkey/generate-register-options");
    invalid.searchParams.set("context", JSON.stringify({
      email: "attacker@example.com",
      token: "development-owner-setup-token-0000000000000",
    }));
    expect((await application!.handle(new Request(invalid))).status).toBe(403);

    const valid = new URL("http://localhost:3000/api/auth/passkey/generate-register-options");
    valid.searchParams.set("context", JSON.stringify({
      email: "owner@example.com",
      token: "development-owner-setup-token-0000000000000",
    }));
    const response = await application!.handle(new Request(valid));
    expect(response.status).toBe(200);
    const options = await response.json() as {
      authenticatorSelection: { residentKey: string; requireResidentKey: boolean; userVerification: string };
    };
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
  });

  test("passkey sign-in options require user verification without an email", async () => {
    const response = await application!.handle(new Request(
      "http://localhost:3000/api/auth/passkey/generate-authenticate-options",
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userVerification: "required" });
  });

  test("passkey authentication cannot create a session while owner revocation holds its lock", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["context-use-owner"]);
      const response = await application!.handle(new Request(
        "http://localhost:3000/api/auth/passkey/verify-authentication",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response: {} }),
        },
      ));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "passkey_authentication_in_progress" });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["context-use-owner"]);
      await client.end();
    }
  });

  test("OAuth grants cannot issue tokens while owner revocation holds its lock", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["context-use-owner"]);
      const response = await application!.handle(new Request(
        "http://localhost:3000/api/auth/oauth2/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: "untrusted-client",
            refresh_token: "untrusted-refresh-token",
          }),
        },
      ));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toEqual({
        error: "temporarily_unavailable",
        error_description: "Owner authentication is changing",
      });
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["context-use-owner"]);
      await client.end();
    }
  });

  test("OAuth token bodies are fully received before taking the owner lock", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    await client.connect();
    let releaseBody: () => void = () => {};
    let bodyReadStarted: () => void = () => {};
    const bodyCanFinish = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const readingSecondChunk = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const encoder = new TextEncoder();
    let finishing = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("grant_type=refresh_token&"));
      },
      async pull(controller) {
        if (finishing) return;
        finishing = true;
        bodyReadStarted();
        await bodyCanFinish;
        controller.enqueue(encoder.encode("client_id=untrusted&refresh_token=untrusted"));
        controller.close();
      },
    });
    const tokenRequest = new Request(
      "http://localhost:3000/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const pendingResponse = Promise.resolve().then(() => application!.handle(tokenRequest));

    try {
      await readingSecondChunk;
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        ["context-use-owner"],
      );
      expect(lock.rows[0]?.locked).toBe(true);
      releaseBody();
      const response = await pendingResponse;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "temporarily_unavailable" });
    } finally {
      releaseBody();
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", ["context-use-owner"]);
      await client.end();
    }
  });

  test("Google social sign-in is not configured", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await application!.handle(new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ provider: "google", callbackURL: "http://localhost:3000/app" }),
      }));
      expect(response.ok).toBe(false);
    } finally {
      errorLog.mockRestore();
    }
  });

  test("dynamic clients default to the private MCP grant and public clients cannot omit PKCE", async () => {
    const emailRegistration = await application!.handle(new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "untrusted email scope test",
        redirect_uris: ["http://127.0.0.1:49320/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "openid email",
      }),
    }));
    expect(emailRegistration.status).toBe(400);

    const registration = await application!.handle(new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "context-use integration test",
        redirect_uris: ["http://127.0.0.1:49321/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }));
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string; scope: string };
    createdClients.push(client.client_id);
    expect(client.scope).toBe("mcp:access");

    for (const resource of ["http://localhost:3000/mcp"]) {
      const authorization = new URL("http://localhost:3000/api/auth/oauth2/authorize");
      authorization.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:49321/callback",
        response_type: "code",
        scope: "mcp:access",
        resource,
        state: "test-state",
      }).toString();
      const response = await application!.handle(new Request(authorization));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("error_description=pkce+is+required+for+public+clients");
    }
  });

  test("a retried refresh rotation replays its replacement without invalidating the token family", async () => {
    const connectionString = requireDatabase();
    const registration = await application!.handle(new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "context-use refresh rotation test",
        redirect_uris: ["http://127.0.0.1:49322/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "offline_access mcp:access",
      }),
    }));
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    createdClients.push(registered.client_id);

    const originalRefreshToken = `refresh-${crypto.randomUUID()}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(originalRefreshToken));
    const storedRefreshToken = Buffer.from(digest).toString("base64url");
    const client = new Client({ connectionString });
    await client.connect();
    let createdOwner = false;
    try {
      const owner = await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified")
         VALUES ('context-use-owner','Owner',$1,true)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [config.OWNER_EMAIL],
      );
      createdOwner = Boolean(owner.rowCount);
      await client.query(
        `INSERT INTO "oauthRefreshToken"(
           id,token,"clientId","userId","expiresAt","createdAt",scopes,resources
         ) VALUES ($1,$2,$3,'context-use-owner',now()+interval '30 days',now(),$4::jsonb,$5::jsonb)`,
        [
          crypto.randomUUID(),
          storedRefreshToken,
          registered.client_id,
          JSON.stringify(["offline_access", "mcp:access"]),
          JSON.stringify([config.MCP_RESOURCE]),
        ],
      );

      const refresh = (token: string) => application!.handle(new Request(
        "http://localhost:3000/api/auth/oauth2/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: registered.client_id,
            refresh_token: token,
          }),
        },
      ));

      const firstResponse = await refresh(originalRefreshToken);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as {
        access_token: string;
        refresh_token: string;
      };
      expect(first.refresh_token).toBeTruthy();

      const replayResponse = await refresh(originalRefreshToken);
      expect(replayResponse.status).toBe(200);
      const replay = await replayResponse.json() as {
        access_token: string;
        refresh_token: string;
      };
      expect(replay.access_token).toBe(first.access_token);
      expect(replay.refresh_token).toBe(first.refresh_token);

      const replacementResponse = await refresh(first.refresh_token);
      expect(replacementResponse.status).toBe(200);
      const replacement = await replacementResponse.json() as { refresh_token: string };
      expect(replacement.refresh_token).toBeTruthy();
      expect(replacement.refresh_token).not.toBe(first.refresh_token);
    } finally {
      try {
        await client.query(`DELETE FROM "oauthClient" WHERE "clientId"=$1`, [registered.client_id]);
        if (createdOwner) {
          await client.query("BEGIN");
          try {
            await client.query("SET LOCAL session_replication_role=replica");
            await client.query(`DELETE FROM "user" WHERE id='context-use-owner'`);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
      } finally {
        await client.end();
      }
    }
  });

  test("idle and absolute session deadlines cannot be refreshed before authorization", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    const sessions = [
      {
        id: crypto.randomUUID(),
        token: `idle-${crypto.randomUUID()}`,
        created: "-2 days",
        updated: "-13 hours",
        expires: "+5 days",
        expectedStatus: 401,
      },
      {
        id: crypto.randomUUID(),
        token: `absolute-${crypto.randomUUID()}`,
        created: "-8 days",
        updated: "-1 hour",
        expires: "+1 day",
        expectedStatus: 401,
      },
      {
        id: crypto.randomUUID(),
        token: `active-${crypto.randomUUID()}`,
        created: "-1 day",
        updated: "-2 hours",
        expires: "+5 days",
        expectedStatus: 200,
      },
    ];
    let createdOwner = false;
    await client.connect();
    try {
      const owner = await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified")
         VALUES ('context-use-owner','Owner',$1,true)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [config.OWNER_EMAIL],
      );
      createdOwner = Boolean(owner.rowCount);
      for (const session of sessions) {
        await client.query(
          `INSERT INTO "session"(
             id,"expiresAt",token,"createdAt","updatedAt","userId"
           ) VALUES (
             $1,now()+$2::interval,$3,now()+$4::interval,now()+$5::interval,'context-use-owner'
           )`,
          [session.id, session.expires, session.token, session.created, session.updated],
        );
      }

      for (const session of sessions) {
        const signature = await makeSignature(session.token, config.BETTER_AUTH_SECRET);
        const before = await client.query<{ updatedAt: Date; expiresAt: Date }>(
          `SELECT "updatedAt","expiresAt" FROM "session" WHERE id=$1`,
          [session.id],
        );
        const response = await application!.handle(new Request("http://localhost:3000/api/dashboard/session", {
          headers: { cookie: `context-use.session_token=${session.token}.${signature}` },
        }));
        expect(response.status).toBe(session.expectedStatus);
        const after = await client.query<{ updatedAt: Date; expiresAt: Date }>(
          `SELECT "updatedAt","expiresAt" FROM "session" WHERE id=$1`,
          [session.id],
        );
        expect(after.rows[0]!.expiresAt.getTime()).toBe(before.rows[0]!.expiresAt.getTime());
        if (session.expectedStatus === 401) {
          expect(after.rows[0]!.updatedAt.getTime()).toBe(before.rows[0]!.updatedAt.getTime());
        } else {
          expect(after.rows[0]!.updatedAt.getTime()).toBeGreaterThan(before.rows[0]!.updatedAt.getTime());
        }
      }
    } finally {
      await client.query(
        `DELETE FROM "session" WHERE id=ANY($1::text[])`,
        [sessions.map(({ id }) => id)],
      ).catch(() => undefined);
      if (createdOwner) {
        await client.query('ALTER TABLE "user" DISABLE TRIGGER user_protect_owner_identity');
        try {
          await client.query(
            `DELETE FROM "user"
             WHERE id='context-use-owner'
               AND NOT EXISTS (SELECT 1 FROM passkey WHERE "userId"='context-use-owner')`,
          );
        } finally {
          await client.query('ALTER TABLE "user" ENABLE TRIGGER user_protect_owner_identity');
        }
      }
      await client.end();
    }
  });

  test("the fixed Nango client and live owner session are both required by the internal gateway", async () => {
    const client = new Client({ connectionString: requireDatabase() });
    const sessionId = crypto.randomUUID();
    const sessionToken = `nango-session-${crypto.randomUUID()}`;
    const accessToken = `nango-access-${crypto.randomUUID()}`;
    const unboundAccessToken = `nango-unbound-${crypto.randomUUID()}`;
    const accessTokenId = crypto.randomUUID();
    const unboundAccessTokenId = crypto.randomUUID();
    const storedAccessToken = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)),
    ).toString("base64url");
    const storedUnboundAccessToken = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(unboundAccessToken)),
    ).toString("base64url");
    const expectedSecret = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.NANGO_OAUTH_CLIENT_SECRET)),
    ).toString("base64url");
    let createdOwner = false;

    await client.connect();
    try {
      // Readiness is also the fail-closed provisioning boundary.
      expect((await authentication!.handle(new Request("http://auth:3002/health"))).status).toBe(200);
      const provisioned = await client.query<{
        clientId: string;
        clientSecret: string;
        disabled: boolean;
        skipConsent: boolean;
        scopes: string[];
        redirectUris: string[];
        tokenEndpointAuthMethod: string;
        grantTypes: string[];
        responseTypes: string[];
        public: boolean;
        type: string;
        requirePKCE: boolean;
      }>(
        `SELECT "clientId","clientSecret",disabled,"skipConsent",scopes,
                "redirectUris","tokenEndpointAuthMethod","grantTypes",
                "responseTypes",public,type,"requirePKCE"
         FROM "oauthClient" WHERE "clientId"=$1`,
        [config.NANGO_OAUTH_CLIENT_ID],
      );
      expect(provisioned.rows[0]).toMatchObject({
        clientId: config.NANGO_OAUTH_CLIENT_ID,
        clientSecret: expectedSecret,
        disabled: false,
        skipConsent: true,
        scopes: ["openid", "email"],
        redirectUris: [`${config.NANGO_ORIGIN}/_context-use-auth/callback`],
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        public: false,
        type: "web",
        requirePKCE: true,
      });

      const owner = await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified")
         VALUES ('context-use-owner','Owner',$1,true)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [config.OWNER_EMAIL],
      );
      createdOwner = Boolean(owner.rowCount);
      await client.query(
        `INSERT INTO "session"(id,"expiresAt",token,"createdAt","updatedAt","userId")
         VALUES ($1,now()+interval '1 day',$2,now()-interval '1 hour',now()-interval '1 minute','context-use-owner')`,
        [sessionId, sessionToken],
      );
      await client.query(
        `INSERT INTO "oauthAccessToken"(
           id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes
         ) VALUES
           ($1,$2,$3,$4,'context-use-owner',now()+interval '10 minutes',now(),$5::jsonb),
           ($6,$7,$3,NULL,'context-use-owner',now()+interval '10 minutes',now(),$5::jsonb)`,
        [
          accessTokenId,
          storedAccessToken,
          config.NANGO_OAUTH_CLIENT_ID,
          sessionId,
          JSON.stringify(["openid", "email"]),
          unboundAccessTokenId,
          storedUnboundAccessToken,
        ],
      );

      const authorize = (token: string, capability = config.AUTH_NANGO_TOKEN) => authentication!.handle(new Request(
        "http://auth:3002/internal/authorize-nango",
        {
          headers: {
            authorization: `Bearer ${token}`,
            "x-context-use-nango-gateway": capability,
          },
        },
      ));

      expect((await authorize(accessToken, "wrong-capability-that-is-still-long-enough")).status).toBe(404);
      expect((await authorize(`forged-${crypto.randomUUID()}`)).status).toBe(401);
      expect((await authorize(unboundAccessToken)).status).toBe(401);
      expect((await authorize(accessToken)).status).toBe(204);

      await client.query(
        `UPDATE "session" SET "updatedAt"=now()-interval '13 hours' WHERE id=$1`,
        [sessionId],
      );
      expect((await authorize(accessToken)).status).toBe(401);
    } finally {
      await client.query(
        `DELETE FROM "oauthAccessToken" WHERE id=ANY($1::text[])`,
        [[accessTokenId, unboundAccessTokenId]],
      ).catch(() => undefined);
      await client.query(`DELETE FROM "session" WHERE id=$1`, [sessionId]).catch(() => undefined);
      if (createdOwner) {
        await client.query('ALTER TABLE "user" DISABLE TRIGGER user_protect_owner_identity');
        try {
          await client.query(
            `DELETE FROM "user"
             WHERE id='context-use-owner'
               AND NOT EXISTS (SELECT 1 FROM passkey WHERE "userId"='context-use-owner')`,
          );
        } finally {
          await client.query('ALTER TABLE "user" ENABLE TRIGGER user_protect_owner_identity');
        }
      }
      await client.end();
    }
  });

  test("the MCP gateway requires an active token bound to a live owner session", async () => {
    const connectionString = requireDatabase();
    const registration = await application!.handle(new Request("http://localhost:3000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "context-use MCP gateway test",
        redirect_uris: ["http://127.0.0.1:49323/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "offline_access mcp:access",
      }),
    }));
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    createdClients.push(registered.client_id);

    const client = new Client({ connectionString });
    const sessionId = crypto.randomUUID();
    const sessionToken = `mcp-session-${crypto.randomUUID()}`;
    const refreshToken = `mcp-refresh-${crypto.randomUUID()}`;
    const refreshTokenId = crypto.randomUUID();
    const consentId = crypto.randomUUID();
    const storedRefreshToken = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refreshToken)),
    ).toString("base64url");
    let createdOwner = false;

    await client.connect();
    try {
      const owner = await client.query(
        `INSERT INTO "user"(id,name,email,"emailVerified")
         VALUES ('context-use-owner','Owner',$1,true)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [config.OWNER_EMAIL],
      );
      createdOwner = Boolean(owner.rowCount);
      await client.query(
        `INSERT INTO "session"(id,"expiresAt",token,"createdAt","updatedAt","userId")
         VALUES ($1,now()+interval '1 day',$2,now()-interval '1 hour',now()-interval '1 minute','context-use-owner')`,
        [sessionId, sessionToken],
      );
      await client.query(
        `INSERT INTO "oauthConsent"(
           id,"clientId","userId",scopes,resources,"createdAt","updatedAt"
         ) VALUES ($1,$2,'context-use-owner',$3::jsonb,$4::jsonb,now(),now())`,
        [
          consentId,
          registered.client_id,
          JSON.stringify(["offline_access", "mcp:access"]),
          JSON.stringify([config.MCP_RESOURCE]),
        ],
      );
      await client.query(
        `INSERT INTO "oauthRefreshToken"(
           id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes,resources
         ) VALUES ($1,$2,$3,$4,'context-use-owner',now()+interval '30 days',now(),$5::jsonb,$6::jsonb)`,
        [
          refreshTokenId,
          storedRefreshToken,
          registered.client_id,
          sessionId,
          JSON.stringify(["offline_access", "mcp:access"]),
          JSON.stringify([config.MCP_RESOURCE]),
        ],
      );

      const tokenResponse = await application!.handle(new Request(
        "http://localhost:3000/api/auth/oauth2/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: registered.client_id,
            refresh_token: refreshToken,
          }),
        },
      ));
      expect(tokenResponse.status).toBe(200);
      const issued = await tokenResponse.json() as { access_token: string };
      expect(issued.access_token.split(".")).toHaveLength(3);
      const opaqueRows = await client.query(
        `SELECT 1 FROM "oauthAccessToken" WHERE "clientId"=$1`,
        [registered.client_id],
      );
      expect(opaqueRows.rowCount).toBe(0);

      const authorize = (token: string, capability = config.AUTH_MCP_TOKEN) => authentication!.handle(new Request(
        "http://auth:3002/internal/authorize-mcp",
        {
          headers: {
            authorization: `Bearer ${token}`,
            "x-context-use-mcp-gateway": capability,
          },
        },
      ));
      const authorizeLineage = () => authentication!.handle(new Request(
        "http://auth:3002/internal/authorize-mcp",
        {
          headers: {
            "x-context-use-mcp-client": registered.client_id,
            "x-context-use-mcp-gateway": config.AUTH_MCP_TOKEN,
            "x-context-use-mcp-session": sessionId,
          },
        },
      ));

      expect((await authorize(issued.access_token, "wrong-capability-that-is-still-long-enough")).status).toBe(404);
      expect((await authorize(`forged-${crypto.randomUUID()}`)).status).toBe(401);
      const active = await authorize(issued.access_token);
      expect(active.status).toBe(200);
      expect(await active.json()).toEqual({ client_id: registered.client_id });
      expect((await authorizeLineage()).status).toBe(204);

      await client.query(`UPDATE "session" SET "updatedAt"=now()-interval '13 hours' WHERE id=$1`, [sessionId]);
      expect((await authorize(issued.access_token)).status).toBe(401);
      expect((await authorizeLineage()).status).toBe(401);
      await client.query(`UPDATE "session" SET "updatedAt"=now() WHERE id=$1`, [sessionId]);
      expect((await authorize(issued.access_token)).status).toBe(200);
      expect((await authorizeLineage()).status).toBe(204);

      const signature = await makeSignature(sessionToken, config.BETTER_AUTH_SECRET);
      const disconnect = await authentication!.handle(new Request(
        `http://localhost:3000/api/dashboard/oauth-clients/${encodeURIComponent(registered.client_id)}`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            cookie: `context-use.session_token=${sessionToken}.${signature}`,
            origin: config.APP_ORIGIN,
            "sec-fetch-site": "same-origin",
            "x-csrf-token": csrfToken({
              userId: "context-use-owner",
              sessionId,
              email: config.OWNER_EMAIL,
            }),
          },
        },
      ));
      expect(disconnect.status).toBe(200);
      expect(await disconnect.json()).toEqual({ revoked: true });
      expect((await authorize(issued.access_token)).status).toBe(401);
      expect((await authorizeLineage()).status).toBe(401);
      const removedClient = await client.query(
        `SELECT 1 FROM "oauthClient" WHERE "clientId"=$1`,
        [registered.client_id],
      );
      expect(removedClient.rowCount).toBe(0);
    } finally {
      await client.query(`DELETE FROM "oauthClient" WHERE "clientId"=$1`, [registered.client_id]).catch(() => undefined);
      await client.query(`DELETE FROM "session" WHERE id=$1`, [sessionId]).catch(() => undefined);
      if (createdOwner) {
        await client.query('ALTER TABLE "user" DISABLE TRIGGER user_protect_owner_identity');
        try {
          await client.query(
            `DELETE FROM "user"
             WHERE id='context-use-owner'
               AND NOT EXISTS (SELECT 1 FROM passkey WHERE "userId"='context-use-owner')`,
          );
        } finally {
          await client.query('ALTER TABLE "user" ENABLE TRIGGER user_protect_owner_identity');
        }
      }
      await client.end();
    }
  });

  test("JWKS endpoint can provision the configured signing key", async () => {
    const response = await application!.handle(new Request("http://localhost:3000/api/auth/jwks"));
    expect(response.status).toBe(200);
    const body = await response.json() as { keys: Array<{ alg: string; crv: string }> };
    expect(body.keys).toContainEqual(expect.objectContaining({ alg: "EdDSA", crv: "Ed25519" }));

    const internal = await authentication!.handle(new Request("http://auth:3002/internal/jwks", {
      headers: { authorization: `Bearer ${config.AUTH_MCP_TOKEN}` },
    }));
    expect(internal.status).toBe(200);
    expect((await internal.json() as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
  });
});
