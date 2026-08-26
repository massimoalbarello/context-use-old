import { dashboardServices } from "../dashboard-services.ts";

export class DashboardMetadataService {
  constructor(
    private readonly config: {
      MCP_RESOURCE: string;
      NODE_ENV: "development" | "test" | "production";
      NANGO_PUBLIC_URL: string;
      NANGO_IMAGE_REFERENCE: string;
    },
  ) {}

  health() {
    return { status: "ok" as const, version: "0.1.100", service: "dashboard" as const };
  }

  mcpEndpoint() {
    return { knowledge_url: this.config.MCP_RESOURCE };
  }

  services() {
    return { services: dashboardServices(this.config) };
  }
}
