import { Elysia } from "elysia";
import { z } from "zod";
import { authPool } from "../../../../../auth.ts";
import { bodyJson, json } from "../../../../../http.ts";
import {
  authenticatorAttachmentSchema,
  confirmEnrollmentIntent,
  confirmRemovalIntent,
  createEnrollmentIntent,
  createRemovalIntent,
  managementIntentIdSchema,
  passkeyAssertionSchema,
  passkeyIdSchema,
  passkeyLabelSchema,
} from "../../../../../passkey-management.ts";
import type { AuthorizeAuthOwner } from "../../../boundary.ts";

const enrollmentIntentSchema = z
  .object({
    name: passkeyLabelSchema,
    authenticator_attachment: authenticatorAttachmentSchema,
  })
  .strict();
const confirmationSchema = z.object({ response: passkeyAssertionSchema }).strict();
const passkeyRemovalSchema = z
  .object({ intent_id: managementIntentIdSchema, response: passkeyAssertionSchema })
  .strict();
const emptyObjectSchema = z.object({}).strict();

export function createDashboardPasskeyController({
  authorizeOwner,
}: {
  authorizeOwner: AuthorizeAuthOwner;
}) {
  return new Elysia()
    .post("/api/dashboard/passkey-enrollment-intents", async ({ request }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      const input = enrollmentIntentSchema.parse(await bodyJson(request));
      return json(
        await createEnrollmentIntent(
          authPool,
          principal,
          input.name,
          input.authenticator_attachment,
        ),
        201,
      );
    })
    .post(
      "/api/dashboard/passkey-enrollment-intents/:intentId/confirm",
      async ({ request, params }) => {
        const principal = await authorizeOwner({ request, mutation: true });
        const input = confirmationSchema.parse(await bodyJson(request));
        return json(
          await confirmEnrollmentIntent(
            authPool,
            principal,
            managementIntentIdSchema.parse(params.intentId),
            input.response,
          ),
        );
      },
    )
    .post("/api/dashboard/passkeys/:passkeyId/removal-intents", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      emptyObjectSchema.parse(await bodyJson(request));
      return json(
        await createRemovalIntent(authPool, principal, passkeyIdSchema.parse(params.passkeyId)),
        201,
      );
    })
    .post("/api/dashboard/passkeys/:passkeyId/remove", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      const input = passkeyRemovalSchema.parse(await bodyJson(request));
      await confirmRemovalIntent(
        authPool,
        principal,
        input.intent_id,
        passkeyIdSchema.parse(params.passkeyId),
        input.response,
      );
      return json({ removed: true, sessions_revoked: true });
    });
}
