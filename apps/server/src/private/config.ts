import { z } from "zod";

const developmentSecret = "development-only-secret-that-is-long-enough";
const developmentSetupTokenHash =
  "0c3f0f8b90068b05d8039bf05db2da4742c31a23e51cfa864a96a0efe17b1694";
const developmentMcpCapabilitySecret = "development-only-mcp-capability-secret";
const developmentNangoToken = "development-auth-nango-gateway-token";
const developmentNangoOAuthClientSecret = "development-nango-oauth-client-secret";
const developmentStorageToken = "development-storage-private-token";

const privateConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  ASSET_ORIGIN: z.string().url().default("http://localhost:3000"),
  PRIVATE_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://context_use_private:development-only@localhost:5432/context_use"),
  OWNER_EMAIL: z.string().email().default("owner@example.com"),
  OWNER_SETUP_TOKEN_HASH: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .default(developmentSetupTokenHash),
  BETTER_AUTH_SECRET: z.string().min(32).default(developmentSecret),
  MCP_ASSET_CAPABILITY_SECRET: z.string().min(32).default(developmentMcpCapabilitySecret),
  OAUTH_ISSUER: z.string().url().default("http://localhost:3000"),
  MCP_RESOURCE: z.string().url().default("http://localhost:3000/mcp"),
  WEBAUTHN_RP_ID: z.string().min(1).default("localhost"),
  WEBAUTHN_RP_NAME: z.string().min(1).default("context-use"),
  STORAGE_SOCKET_PATH: z.string().min(1).default("/tmp/context-use-storage.sock"),
  STORAGE_PRIVATE_TOKEN: z.string().min(32).default(developmentStorageToken),
  WEB_DIST: z.string().default("./apps/web/dist"),
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(43_200),
  SESSION_MAX_SECONDS: z.coerce.number().int().positive().default(604_800),
  NANGO_ORIGIN: z.string().url().default("http://localhost:3003"),
  NANGO_OAUTH_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .default("context-use-nango-dashboard"),
  NANGO_OAUTH_CLIENT_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/)
    .default(developmentNangoOAuthClientSecret),
  AUTH_NANGO_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{32,256}$/)
    .default(developmentNangoToken),
  NANGO_PUBLIC_URL: z.union([z.literal(""), z.string().url()]).default(""),
  NANGO_IMAGE_REFERENCE: z.string().max(512).default(""),
  NANGO_INTERNAL_URL: z.string().url().default("http://localhost:3003"),
  NANGO_PIPELINE_API_KEY: z.union([z.literal(""), z.string().min(16).max(4_096)]).default(""),
});

export type PrivateConfig = z.infer<typeof privateConfigSchema>;

const obsoletePrivateVariables = [
  "DATABASE_URL",
  "AUTH_DATABASE_URL",
  "MCP_DATABASE_URL",
  "CONFIRMATION_DATABASE_URL",
  "AUTH_INTERNAL_URL",
  "CONFIRMATION_INTERNAL_URL",
  "DASHBOARD_AUTHORITY_URL",
  "AUTH_DASHBOARD_TOKEN",
  "AUTH_MCP_TOKEN",
  "CONFIRMATION_GATEWAY_TOKEN",
  "CONFIRMATION_DASHBOARD_TOKEN",
  "STORAGE_DASHBOARD_TOKEN",
  "STORAGE_MCP_TOKEN",
] as const;

const forbiddenPrivateVariables = [
  "PUBLIC_DATABASE_URL",
  "STORAGE_DATABASE_URL",
  "STORAGE_PUBLIC_TOKEN",
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
] as const;

export function loadPrivateConfig(environment: NodeJS.ProcessEnv): PrivateConfig {
  const config = privateConfigSchema.parse(environment);
  if (config.NODE_ENV !== "production") {
    return config;
  }

  const unsafe: string[] = [];
  const app = exactHttpsOrigin({ value: config.APP_ORIGIN, name: "APP_ORIGIN", unsafe });
  const assets = exactHttpsOrigin({ value: config.ASSET_ORIGIN, name: "ASSET_ORIGIN", unsafe });
  if (app && assets && assets.hostname !== `assets.${app.hostname}`) {
    unsafe.push("ASSET_ORIGIN must use the dedicated assets subdomain");
  }
  if (config.OAUTH_ISSUER !== config.APP_ORIGIN) {
    unsafe.push("OAUTH_ISSUER must equal APP_ORIGIN");
  }
  if (config.MCP_RESOURCE !== `${config.APP_ORIGIN}/mcp`) {
    unsafe.push("MCP_RESOURCE must be the canonical /mcp URI");
  }
  if (app && config.WEBAUTHN_RP_ID !== app.hostname) {
    unsafe.push("WEBAUTHN_RP_ID must equal the application hostname");
  }
  if (config.BETTER_AUTH_SECRET === developmentSecret) {
    unsafe.push("BETTER_AUTH_SECRET must be changed");
  }
  if (config.MCP_ASSET_CAPABILITY_SECRET === developmentMcpCapabilitySecret) {
    unsafe.push("MCP_ASSET_CAPABILITY_SECRET must be changed");
  }
  if (config.STORAGE_PRIVATE_TOKEN === developmentStorageToken) {
    unsafe.push("STORAGE_PRIVATE_TOKEN must be changed");
  }
  if (config.AUTH_NANGO_TOKEN === developmentNangoToken) {
    unsafe.push("AUTH_NANGO_TOKEN must be changed");
  }
  if (config.NANGO_OAUTH_CLIENT_SECRET === developmentNangoOAuthClientSecret) {
    unsafe.push("NANGO_OAUTH_CLIENT_SECRET must be changed");
  }
  if (config.OWNER_EMAIL === "owner@example.com") {
    unsafe.push("OWNER_EMAIL must be configured");
  }
  if (config.OWNER_SETUP_TOKEN_HASH === developmentSetupTokenHash) {
    unsafe.push("OWNER_SETUP_TOKEN_HASH must be changed");
  }
  if (config.SESSION_MAX_SECONDS > 604_800) {
    unsafe.push("dashboard sessions cannot exceed seven days");
  }
  if (
    config.SESSION_IDLE_SECONDS > 43_200 ||
    config.SESSION_IDLE_SECONDS >= config.SESSION_MAX_SECONDS
  ) {
    unsafe.push("dashboard idle timeout cannot exceed twelve hours");
  }
  const nango = exactHttpsOrigin({ value: config.NANGO_ORIGIN, name: "NANGO_ORIGIN", unsafe });
  if (app && nango && nango.hostname !== `nango.${app.hostname}`) {
    unsafe.push("NANGO_ORIGIN must use the dedicated Nango subdomain");
  }
  const hasNangoUrl = Boolean(config.NANGO_PUBLIC_URL);
  const hasNangoImage = Boolean(config.NANGO_IMAGE_REFERENCE);
  if (hasNangoUrl !== hasNangoImage) {
    unsafe.push("NANGO_PUBLIC_URL and NANGO_IMAGE_REFERENCE must be configured together");
  }
  if (hasNangoUrl) {
    exactHttpsOrigin({ value: config.NANGO_PUBLIC_URL, name: "NANGO_PUBLIC_URL", unsafe });
  }
  if (config.NANGO_INTERNAL_URL !== "http://nango-server:3003") {
    unsafe.push("NANGO_INTERNAL_URL must use the isolated Nango pipeline network");
  }
  assertDatabaseRole({
    connection: config.PRIVATE_DATABASE_URL,
    role: "context_use_private",
    name: "PRIVATE_DATABASE_URL",
    unsafe,
  });
  for (const name of [...obsoletePrivateVariables, ...forbiddenPrivateVariables]) {
    if (environment[name] !== undefined) {
      unsafe.push(`${name} must not be present in the private service`);
    }
  }
  for (const name of [
    "DB_AUTH_PASSWORD",
    "DB_DASHBOARD_PASSWORD",
    "DB_MCP_PASSWORD",
    "DB_PUBLIC_PASSWORD",
    "DB_CONFIRMATION_PASSWORD",
    "DB_STORAGE_PASSWORD",
    "DB_BACKUP_PASSWORD",
  ]) {
    if (environment[name] !== undefined) {
      unsafe.push(`${name} must not be present in the private service`);
    }
  }
  if (unsafe.length) {
    throw new Error(`Unsafe private configuration: ${unsafe.join("; ")}`);
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
  name,
  unsafe,
}: {
  connection: string;
  role: string;
  name: string;
  unsafe: string[];
}): void {
  try {
    const parsed = new URL(connection);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== role
    ) {
      unsafe.push(`${name} must use only ${role}`);
    }
  } catch {
    unsafe.push(`${name} must be a valid PostgreSQL URL`);
  }
}
