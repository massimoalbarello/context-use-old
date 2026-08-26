import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

export const ownerUserId = "context-use-owner";

export const confirmationKindSchema = z.enum([
  "publication",
  "knowledge_export",
  "knowledge_import",
  "page_deletion",
]);

export const principalSchema = z
  .object({
    owner_user_id: z.literal(ownerUserId),
    session_id: z.string().min(1).max(512),
  })
  .strict();

export const confirmationSchema = z
  .object({
    intent_id: z.string().uuid(),
    response: z.custom<AuthenticationResponseJSON>((value) =>
      Boolean(value && typeof value === "object"),
    ),
  })
  .strict();

export const browserConfirmationSchema = z
  .object({
    principal: principalSchema,
    confirmation: confirmationSchema,
  })
  .strict();
