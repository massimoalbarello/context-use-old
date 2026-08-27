import { z } from "zod";

const developmentStorageToken = "development-storage-public-token";

const publicConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3005),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  ASSET_ORIGIN: z.string().url().default("http://localhost:3000"),
  PUBLIC_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://context_use_public:development-only@localhost:5432/context_use"),
  STORAGE_SOCKET_PATH: z.string().min(1).default("/tmp/context-use-storage.sock"),
  STORAGE_PUBLIC_TOKEN: z.string().min(32).default(developmentStorageToken),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;

export function loadPublicConfig(environment: NodeJS.ProcessEnv): PublicConfig {
  const config = publicConfigSchema.parse(environment);
  if (config.NODE_ENV !== "production") {
    return config;
  }

  const unsafe: string[] = [];
  const app = exactHttpsOrigin({ value: config.APP_ORIGIN, name: "APP_ORIGIN", unsafe });
  const assets = exactHttpsOrigin({ value: config.ASSET_ORIGIN, name: "ASSET_ORIGIN", unsafe });
  if (app && assets && assets.hostname !== `assets.${app.hostname}`) {
    unsafe.push("ASSET_ORIGIN must use the dedicated assets subdomain");
  }
  assertDatabaseRole({
    connection: config.PUBLIC_DATABASE_URL,
    role: "context_use_public",
    unsafe,
  });
  if (config.STORAGE_PUBLIC_TOKEN === developmentStorageToken) {
    unsafe.push("STORAGE_PUBLIC_TOKEN must be changed");
  }
  for (const name of [
    "PRIVATE_DATABASE_URL",
    "STORAGE_DATABASE_URL",
    "STORAGE_PRIVATE_TOKEN",
    "BETTER_AUTH_SECRET",
    "MCP_ASSET_CAPABILITY_SECRET",
    "AUTH_NANGO_TOKEN",
    "NANGO_OAUTH_CLIENT_SECRET",
    "NANGO_PIPELINE_API_KEY",
    "MIGRATOR_DATABASE_URL",
    "DATABASE_ADMIN_URL",
    "POSTGRES_PASSWORD",
    "PGPASSWORD",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_CREDENTIALS_FILE",
    "ASSET_BUCKET",
    "KMS_KEY_ID",
  ]) {
    if (environment[name] !== undefined) {
      unsafe.push(`${name} must not be present in the public service`);
    }
  }
  if (unsafe.length) {
    throw new Error(`Unsafe public configuration: ${unsafe.join("; ")}`);
  }
  return config;
}

function exactHttpsOrigin({
  value,
  name,
  unsafe,
}: {
  value: string;
  name: string;
  unsafe: string[];
}): URL | null {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    unsafe.push(`${name} must be an exact bare HTTPS origin`);
    return null;
  }
  return url;
}

function assertDatabaseRole({
  connection,
  role,
  unsafe,
}: {
  connection: string;
  role: string;
  unsafe: string[];
}): void {
  try {
    const parsed = new URL(connection);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role
    ) {
      unsafe.push(`PUBLIC_DATABASE_URL must use only ${role}`);
    }
  } catch {
    unsafe.push("PUBLIC_DATABASE_URL must be a valid PostgreSQL URL");
  }
}
