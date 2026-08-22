import { afterEach, describe, expect, test } from "bun:test";
import { app } from "./app.ts";
import {
  knowledgePreparationApplyResponse,
  knowledgePreparationPlanResponse,
} from "./knowledge-prepare.ts";

const authHandlerGlobal = globalThis as typeof globalThis & {
  __contextUseAuthHandler?: (request: Request) => Promise<Response> | Response;
};

afterEach(() => {
  delete authHandlerGlobal.__contextUseAuthHandler;
});

describe("dashboard knowledge template boundary", () => {
  test("keeps privileged corpus preparation out of the long-lived dashboard process", async () => {
    const [dashboard, templateCommand] = await Promise.all([
      Bun.file(new URL("./app.ts", import.meta.url)).text(),
      Bun.file(new URL("./template-command.ts", import.meta.url)).text(),
    ]);
    expect(dashboard).not.toContain("prepareKnowledgeCorpus");
    expect(dashboard).not.toContain("CORPUS_DATABASE_URL");
    expect(templateCommand).not.toContain("runKnowledgePrepareCommand");
    expect(templateCommand).toContain(
      "Template apply must run through the isolated knowledge-prepare service",
    );
  });

  test("marks dashboard plan and apply as template-only with isolated preparation pending", () => {
    const template = {
      template: "default",
      applied: false,
      actions: [{ action: "unchanged" as const, path: "agents", detail: "Current" }],
    };
    const plan = knowledgePreparationPlanResponse(template);
    const apply = knowledgePreparationApplyResponse(template);

    expect(plan.preparation_scope).toEqual({
      managed_operational_documents: "deployment_one_shot",
      hypermedia_corpus: "deployment_one_shot",
    });
    expect(apply.preparation_scope).toEqual(plan.preparation_scope);
    expect(plan.preparation_required).toBe(true);
    expect(apply.preparation_required).toBe(true);
    expect(apply.preparation_action).toBe("run_deployment_knowledge_prepare");
    expect(apply).not.toHaveProperty("corpus");
  });

  test("requires an owner session to plan or apply a template", async () => {
    authHandlerGlobal.__contextUseAuthHandler = () => new Response(null, { status: 401 });

    const plan = await app.handle(new Request("http://localhost:3000/api/dashboard/knowledge-template/plan"));
    const apply = await app.handle(new Request("http://localhost:3000/api/dashboard/knowledge-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force_template: false }),
    }));

    expect(plan.status).toBe(401);
    expect(apply.status).toBe(401);
  });

  test("requests JSON and CSRF authorization before applying a template", async () => {
    let authorizationKind = "";
    authHandlerGlobal.__contextUseAuthHandler = async (request) => {
      const input = await request.json() as { kind?: string };
      authorizationKind = input.kind ?? "";
      return new Response(null, { status: 401 });
    };

    const response = await app.handle(new Request("http://localhost:3000/api/dashboard/knowledge-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force_template: true }),
    }));

    expect(response.status).toBe(401);
    expect(authorizationKind).toBe("json");
  });

  test("rejects invalid force previews before querying template state", async () => {
    authHandlerGlobal.__contextUseAuthHandler = () => Response.json({
      userId: "context-use-owner",
      sessionId: "session-id",
      email: "owner@example.com",
    });

    const response = await app.handle(new Request("http://localhost:3000/api/dashboard/knowledge-template/plan?force_template=yes"));
    expect(response.status).toBe(422);
  });
});
