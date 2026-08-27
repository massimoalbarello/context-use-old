import { archiveSourceRecordSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { z } from "zod";
import { bodyJson, json, problem } from "#http/responses.ts";
import type { AuthorizeOwner } from "#private/auth/dashboard-owner-authorizer.ts";
import type { DashboardObjectsService } from "#private/services/dashboard/objects-service.ts";

export function createSourceRecordArchiveController({
  authorizeOwner,
  service,
}: {
  authorizeOwner: AuthorizeOwner;
  service: DashboardObjectsService;
}) {
  return new Elysia().post(
    "/api/dashboard/source-records/:objectId/archive",
    async ({ request, params }) => {
      await authorizeOwner({ request, mode: "json" });
      const objectId = z.string().uuid().parse(params.objectId);
      const input = archiveSourceRecordSchema
        .omit({ object_id: true })
        .parse(await bodyJson(request));
      const result = await service.archiveSourceRecord({
        objectId,
        expectedRevisionId: input.expected_revision_id,
      });
      if (result.state === "not_found") {
        return problem("Source record not found", 404, "not_found");
      }
      if (result.state === "revision_conflict") {
        return problem(
          "Source record changed; reload it before archiving",
          409,
          "revision_conflict",
        );
      }
      if (result.state !== "found") {
        throw new Error(`Unexpected source-record archive state: ${result.state}`);
      }
      return json(result.record);
    },
  );
}
