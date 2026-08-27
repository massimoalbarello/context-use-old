import { z } from "zod";

const developmentStorageToken = "development-storage-private-token";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORPUS_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://context_use_corpus:development-only@localhost:5432/context_use"),
  STORAGE_SOCKET_PATH: z.string().min(1).default("/tmp/context-use-storage.sock"),
  STORAGE_PRIVATE_TOKEN: z.string().min(32).default(developmentStorageToken),
});

export type HypermediaBootstrapConfig = z.infer<typeof configSchema>;

export function loadHypermediaBootstrapConfig(
  environment: NodeJS.ProcessEnv,
): HypermediaBootstrapConfig {
  const config = configSchema.parse(environment);
  const database = new URL(config.CORPUS_DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    decodeURIComponent(database.username) !== "context_use_corpus"
  ) {
    throw new Error("CORPUS_DATABASE_URL must use only context_use_corpus");
  }
  if (
    config.NODE_ENV === "production" &&
    config.STORAGE_PRIVATE_TOKEN === developmentStorageToken
  ) {
    throw new Error("STORAGE_PRIVATE_TOKEN must be changed");
  }
  return config;
}
