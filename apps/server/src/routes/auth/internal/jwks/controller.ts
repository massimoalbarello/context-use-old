import { Elysia } from "elysia";
import { auth } from "../../../../auth.ts";
import { problem } from "../../../../http.ts";
import { hasInternalCapability } from "../../../../internal-capability.ts";

export function createInternalJwksController({
  appOrigin,
  mcpToken,
}: {
  appOrigin: string;
  mcpToken: string;
}) {
  return new Elysia().get("/internal/jwks", ({ request }) => {
    if (!hasInternalCapability(request, mcpToken)) {
      return problem("Not found", 404, "not_found");
    }
    return auth.handler(new Request(`${appOrigin}/api/auth/jwks`));
  });
}
