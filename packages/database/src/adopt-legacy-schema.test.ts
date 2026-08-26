import { describe, expect, test } from "bun:test";
import { replacementFunctionDefinitions } from "./adopt-legacy-schema.ts";

describe("legacy schema normalization catalog", () => {
  test("extracts only complete canonical routine definitions", () => {
    const applicationMigrationSql = [
      "CREATE FUNCTION public.begin_hypermedia_bootstrap() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN NULL; END;",
      "$$;",
      "CREATE FUNCTION public.begin_publication_intent() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN NULL; END;",
      "$$;",
      "CREATE FUNCTION public.consume_confirmation_challenge() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN NULL; END;",
      "$$;",
      "CREATE FUNCTION public.lock_publication_context() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN NULL; END;",
      "$$;",
      "CREATE FUNCTION public.protect_passkey_credential() RETURNS trigger LANGUAGE plpgsql AS $$",
      "BEGIN RETURN NULL; END;",
      "$$;",
      "CREATE FUNCTION public.remove_owner_passkey() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN NULL; END;",
      "$$;",
    ].join("\n");
    const definitions = replacementFunctionDefinitions({ applicationMigrationSql });
    expect(definitions).toHaveLength(6);
    expect(
      definitions.every((definition) => definition.startsWith("CREATE OR REPLACE FUNCTION")),
    ).toBe(true);
    expect(definitions.every((definition) => definition.endsWith("\n$$;"))).toBe(true);
  });

  test("refuses a target catalog missing a required routine", () => {
    expect(() => replacementFunctionDefinitions({ applicationMigrationSql: "SELECT 1;" })).toThrow(
      "Application migration is missing begin_hypermedia_bootstrap",
    );
  });
});
