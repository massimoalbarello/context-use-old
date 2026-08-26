import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json, problem } from "../../../../../http.ts";
import type { DashboardKnowledgeImportsService } from "../../../../../services/dashboard-knowledge-imports-service.ts";
import type { AuthorizeOwner } from "../../../authorization.ts";

const createImportSchema = z
  .object({
    filename: z.string().min(1).max(1024),
    size_bytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 ** 3),
  })
  .strict();

export function createKnowledgeImportsController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardKnowledgeImportsService;
}) {
  return new Elysia().post("/api/dashboard/knowledge-imports", async ({ request }) => {
    const principal = await authorizeOwner({ request, mode: "json" });
    const input = createImportSchema.parse(await bodyJson(request));
    const result = await service.create({
      filename: input.filename,
      sizeBytes: input.size_bytes,
      principal,
    });
    return result.state === "created"
      ? json(result.import, 201)
      : problem(
          "Full knowledge bundles can only be imported into a fresh Context Use instance.",
          409,
          "instance_not_fresh",
        );
  });
}
