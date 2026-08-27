import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { bodyJson, json } from "#http/responses.ts";
import type { AuthorizeAuthOwner } from "#private/auth/owner-authorizer.ts";
import {
  authenticatorAttachmentSchema,
  confirmEnrollmentIntent,
  confirmRemovalIntent,
  createEnrollmentIntent,
  createRemovalIntent,
  managementIntentIdSchema,
  type PasskeyManagementPolicy,
  passkeyAssertionSchema,
  passkeyIdSchema,
  passkeyLabelSchema,
} from "#private/auth/passkey-management.ts";

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
  passkeyPolicy,
  pool,
}: {
  authorizeOwner: AuthorizeAuthOwner;
  passkeyPolicy: PasskeyManagementPolicy;
  pool: Pool;
}) {
  return new Elysia()
    .post("/api/dashboard/passkey-enrollment-intents", async ({ request }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      const input = enrollmentIntentSchema.parse(await bodyJson(request));
      return json(
        await createEnrollmentIntent(
          pool,
          principal,
          input.name,
          input.authenticator_attachment,
          passkeyPolicy,
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
            pool,
            principal,
            managementIntentIdSchema.parse(params.intentId),
            input.response,
            passkeyPolicy,
          ),
        );
      },
    )
    .post("/api/dashboard/passkeys/:passkeyId/removal-intents", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      emptyObjectSchema.parse(await bodyJson(request));
      return json(
        await createRemovalIntent(
          pool,
          principal,
          passkeyIdSchema.parse(params.passkeyId),
          passkeyPolicy,
        ),
        201,
      );
    })
    .post("/api/dashboard/passkeys/:passkeyId/remove", async ({ request, params }) => {
      const principal = await authorizeOwner({ request, mutation: true });
      const input = passkeyRemovalSchema.parse(await bodyJson(request));
      await confirmRemovalIntent(
        pool,
        principal,
        input.intent_id,
        passkeyIdSchema.parse(params.passkeyId),
        input.response,
        passkeyPolicy,
      );
      return json({ removed: true, sessions_revoked: true });
    });
}
