import { Elysia } from "elysia";
import { z } from "zod";
import { dashboardPrincipal } from "../../../../auth.ts";
import { bodyJson, json, problem } from "../../../../http.ts";
import { hasInternalCapability } from "../../../../internal-capability.ts";
import {
  assertDashboardRequestSecurity,
  assertDashboardUploadSecurity,
} from "../../../../security.ts";

const internalAuthorizationSchema = z
  .object({
    method: z.string().min(1).max(12),
    pathname: z.string().startsWith("/").max(2_000),
    kind: z.enum(["read", "json", "upload"]),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export function createAuthorizeDashboardController({
  appOrigin,
  dashboardToken,
}: {
  appOrigin: string;
  dashboardToken: string;
}) {
  return new Elysia().post("/internal/authorize-dashboard", async ({ request }) => {
    if (!hasInternalCapability(request, dashboardToken)) {
      return problem("Not found", 404, "not_found");
    }
    const input = internalAuthorizationSchema.parse(await bodyJson(request));
    const reconstructed = new Request(`${appOrigin}${input.pathname}`, {
      method: input.method,
      headers: input.headers,
    });
    const principal = await dashboardPrincipal(reconstructed);
    if (!principal) {
      return problem("Dashboard session required", 401, "unauthorized");
    }
    if (input.kind === "json") {
      assertDashboardRequestSecurity(reconstructed, principal);
    }
    if (input.kind === "upload") {
      assertDashboardUploadSecurity(reconstructed, principal);
    }
    return json(principal);
  });
}
