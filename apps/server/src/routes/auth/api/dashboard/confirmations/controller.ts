import { Elysia } from "elysia";
import { forwardBrowserConfirmation } from "../../../../../confirmation-gateway.ts";
import { bodyJson } from "../../../../../http.ts";
import type { AuthorizeAuthOwner } from "../../../boundary.ts";

export function createDashboardConfirmationController({
  authorizeOwner,
}: {
  authorizeOwner: AuthorizeAuthOwner;
}) {
  const forward = async ({
    request,
    kind,
  }: {
    request: Request;
    kind: "publication" | "knowledge_export" | "knowledge_import" | "page_deletion";
  }) => {
    const principal = await authorizeOwner({ request, mutation: true });
    return forwardBrowserConfirmation(kind, await bodyJson(request), principal);
  };
  return new Elysia()
    .post("/api/dashboard/publications/confirm", ({ request }) =>
      forward({ request, kind: "publication" }),
    )
    .post("/api/dashboard/knowledge-bundle-exports/confirm", ({ request }) =>
      forward({ request, kind: "knowledge_export" }),
    )
    .post("/api/dashboard/knowledge-imports/confirm", ({ request }) =>
      forward({ request, kind: "knowledge_import" }),
    )
    .post("/api/dashboard/page-deletions/confirm", ({ request }) =>
      forward({ request, kind: "page_deletion" }),
    );
}
