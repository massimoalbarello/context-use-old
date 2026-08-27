import { Client } from "pg";
import { disposableDatabaseUrl } from "./disposable-database.ts";

export const seedTestStateSql = `
  INSERT INTO public.knowledge_settings(singleton)
  VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;
  INSERT INTO public.publication_settings(singleton,entrypoint_public_id,updated_at)
  VALUES (true,NULL,NULL)
  ON CONFLICT (singleton) DO NOTHING;
`;

async function seedTestState(): Promise<void> {
  const url = await disposableDatabaseUrl();
  if (!url) {
    throw new Error("TEST_DATABASE_URL must identify a marked disposable database");
  }
  const client = new Client({ connectionString: url, application_name: "context-use-test-seed" });
  await client.connect();
  try {
    await client.query(seedTestStateSql);
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  await seedTestState();
}
