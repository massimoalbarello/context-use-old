import { z } from "zod";

const developmentPrivateToken = "development-storage-private-token";
const developmentPublicToken = "development-storage-public-token";

const storageConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  STORAGE_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://context_use_storage:development-only@localhost:5432/context_use"),
  STORAGE_SOCKET_PATH: z.string().min(1).default("/tmp/context-use-storage.sock"),
  STORAGE_PRIVATE_TOKEN: z.string().min(32).default(developmentPrivateToken),
  STORAGE_PUBLIC_TOKEN: z.string().min(32).default(developmentPublicToken),
  AWS_REGION: z.string().default("eu-west-2"),
  AWS_CREDENTIALS_FILE: z.string().default(""),
  AWS_EC2_METADATA_DISABLED: z.enum(["true", "false"]).default("false"),
  S3_ENDPOINT: z.union([z.literal(""), z.string().url()]).default(""),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  ASSET_BUCKET: z.string().default(""),
  KMS_KEY_ID: z.string().default(""),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

export function loadStorageConfig(environment: NodeJS.ProcessEnv): StorageConfig {
  const config = storageConfigSchema.parse(environment);
  if (config.NODE_ENV !== "production") {
    return config;
  }

  const unsafe: string[] = [];
  assertDatabaseRole({
    connection: config.STORAGE_DATABASE_URL,
    role: "context_use_storage",
    unsafe,
  });
  if (config.STORAGE_PRIVATE_TOKEN === developmentPrivateToken) {
    unsafe.push("STORAGE_PRIVATE_TOKEN must be changed");
  }
  if (config.STORAGE_PUBLIC_TOKEN === developmentPublicToken) {
    unsafe.push("STORAGE_PUBLIC_TOKEN must be changed");
  }
  if (config.STORAGE_PRIVATE_TOKEN === config.STORAGE_PUBLIC_TOKEN) {
    unsafe.push("private and public storage capabilities must be distinct");
  }
  if (!config.ASSET_BUCKET) {
    unsafe.push("ASSET_BUCKET is required");
  }
  if (!config.KMS_KEY_ID) {
    unsafe.push("KMS_KEY_ID is required");
  }
  if (config.S3_ENDPOINT) {
    unsafe.push("production storage must use the AWS S3 endpoint");
  }
  if (config.S3_FORCE_PATH_STYLE !== "false") {
    unsafe.push("production storage must use virtual-hosted S3 addressing");
  }
  if (config.AWS_CREDENTIALS_FILE !== "/run/context-use-aws-storage/credentials.json") {
    unsafe.push("storage must use the scoped AWS credential file");
  }
  if (config.AWS_EC2_METADATA_DISABLED !== "true") {
    unsafe.push("storage must disable EC2 instance metadata");
  }
  for (const name of [
    "PRIVATE_DATABASE_URL",
    "PUBLIC_DATABASE_URL",
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
  ]) {
    if (environment[name] !== undefined) {
      unsafe.push(`${name} must not be present in the storage service`);
    }
  }
  if (unsafe.length) {
    throw new Error(`Unsafe storage configuration: ${unsafe.join("; ")}`);
  }
  return config;
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
      unsafe.push(`STORAGE_DATABASE_URL must use only ${role}`);
    }
  } catch {
    unsafe.push("STORAGE_DATABASE_URL must be a valid PostgreSQL URL");
  }
}
