type RequestApplication = {
  handle(request: Request): Promise<Response> | Response;
};

export function createDevelopmentApp({
  privateApp,
  publicApp,
}: {
  privateApp: RequestApplication;
  publicApp: RequestApplication;
}) {
  return {
    handle(request: Request): Promise<Response> | Response {
      const path = new URL(request.url).pathname;
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
        return publicApp.handle(request);
      }
      return privateApp.handle(request);
    },
  };
}
