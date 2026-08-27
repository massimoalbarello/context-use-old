import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

export const confirmationSchema = z
  .object({
    intent_id: z.string().uuid(),
    response: z.custom<AuthenticationResponseJSON>((value) =>
      Boolean(value && typeof value === "object"),
    ),
  })
  .strict();
