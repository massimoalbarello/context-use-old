import { deleteSourceRecordSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json, problem } from "../../../../../../http.ts";
import type { DashboardObjectsService } from "../../../../../../services/dashboard-objects-service.ts";
import type { AuthorizeOwner } from "../../../../authorization.ts";

export function createSourceRecordController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardObjectsService;
}) {
  return new Elysia()
    .get("/api/dashboard/source-records/:objectId", async ({ request, params }) => {
      await authorizeOwner({ request });
      const record = await service.sourceRecord(z.string().uuid().parse(params.objectId));
      return record ? json(record) : problem("Source record not found", 404, "not_found");
    })
    .delete("/api/dashboard/source-records/:objectId", async ({ request, params }) => {
      await authorizeOwner({ request, mode: "json" });
      const objectId = z.string().uuid().parse(params.objectId);
      const input = deleteSourceRecordSchema
        .omit({ object_id: true })
        .parse(await bodyJson(request));
      const result = await service.deleteSourceRecord({
        objectId,
        expectedRevisionId: input.expected_revision_id,
      });
      if (result.state === "not_found") {
        return problem("Source record not found", 404, "not_found");
      }
      if (result.state === "revision_conflict") {
        return problem(
          "Source record changed; reload it before deleting",
          409,
          "revision_conflict",
        );
      }
      if (result.state === "not_archived") {
        return problem(
          "Archive the source record before permanently deleting it",
          409,
          "record_not_archived",
        );
      }
      if (result.state !== "deleted") {
        throw new Error(`Unexpected source-record deletion state: ${result.state}`);
      }
      return json({ object_id: result.objectId, deleted: true });
    });
}
