type RequestApplication = {
  handle(request: Request): Promise<Response> | Response;
};

export function createCombinedApp({
  auth,
  dashboard,
  mcp,
  publicWeb,
}: {
  auth: RequestApplication;
  dashboard: RequestApplication;
  mcp: RequestApplication;
  publicWeb: RequestApplication;
}) {
  const target = (request: Request): RequestApplication => {
    const path = new URL(request.url).pathname;
    if (
      path.startsWith("/api/auth/") ||
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return auth;
    }
    if (
      path === "/mcp" ||
      path.startsWith("/api/mcp/") ||
      path.startsWith("/.well-known/oauth-protected-resource")
    ) {
      return mcp;
    }
    if (
      path === "/" ||
      path === "/robots.txt" ||
      path === "/sitemap.xml" ||
      path === "/llms.txt" ||
      path === "/llms-full.txt" ||
      path === "/public.css" ||
      path === "/content.css" ||
      path === "/p" ||
      path.startsWith("/p/") ||
      path.startsWith("/a/")
    ) {
      return publicWeb;
    }
    return dashboard;
  };
  return {
    handle(request: Request): Promise<Response> | Response {
      return target(request).handle(request);
    },
  };
}
