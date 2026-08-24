import {
  mapConcurrently,
  PathlessPublicRepository,
  createPool,
  type PathlessPublicActiveAssetRoute,
  type PathlessPublicActivePageRoute,
} from "@context-use/database";
import { pathlessPublicRouteSchema } from "@context-use/shared";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { json, routeError } from "./http.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderLlmsFullTxt, renderLlmsTxt, renderPublicPageMarkdown } from "./public-llms.ts";
import {
  externalProfileLinks,
  renderRobotsTxt,
  renderSitemapXml,
} from "./public-discovery.ts";
import {
  IMAGE_LAYOUT_STYLES,
  publicPageStyles,
  renderPublicLandingDocument,
  renderPublicPageDocument,
} from "./public-page.ts";
import type { PublicPageContent } from "./public-content.ts";
import { requestMatchesOrigin, securityHeaders } from "./security.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { assetContentResponse } from "./asset-content.ts";

const pool = createPool(config.PUBLIC_DATABASE_URL, { application_name: "context-use-public-web" });
const pathlessPublicData = new PathlessPublicRepository(pool);
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_PUBLIC_TOKEN,
  publicOnly: true,
});
const htmlHeaders = { ...securityHeaders, "content-type": "text/html; charset=utf-8" };
const textHeaders = { ...securityHeaders, "content-type": "text/plain; charset=utf-8" };
const agentTextHeaders = { ...textHeaders, "x-robots-tag": "noindex, follow" };
const markdownHeaders = {
  ...securityHeaders,
  "content-type": "text/markdown; charset=utf-8",
  "x-robots-tag": "noindex, follow",
};
const xmlHeaders = { ...securityHeaders, "content-type": "application/xml; charset=utf-8" };
const unavailableResolvers = {
  page: async () => ({ available: false as const }),
  directory: async () => ({ available: false as const }),
  pagePath: async () => ({ available: false as const }),
  asset: async () => ({ available: false as const }),
  publicAssetPath: async (path: string) => {
    const parsed = pathlessPublicRouteSchema.safeParse(`/a/${path}`);
    if (!parsed.success) return { available: false as const };
    const route = await pathlessPublicData.resolve(parsed.data);
    return route.state === "active" && route.route_kind === "asset"
      ? {
          available: true as const,
          href: `${config.ASSET_ORIGIN}${route.canonical_path}`,
          contentType: route.public_content_type,
        }
      : { available: false as const };
  },
};

function pathlessPublicPage(
  page: Awaited<ReturnType<PathlessPublicRepository["pages"]>>[number],
  bodyMarkdown = "",
): PublicPageContent {
  return {
    public_id: page.public_id,
    title: page.public_title,
    summary: page.public_summary,
    body_markdown: bodyMarkdown,
    last_edited_at: page.public_last_edited_at,
  };
}

async function pathlessPublishedPages(full: boolean): Promise<PublicPageContent[]> {
  const pages = await pathlessPublicData.pages();
  if (!full) return pages.map((page) => pathlessPublicPage(page));
  return mapConcurrently(pages, 8, async (page) => pathlessPublicPage(
    page,
    await storage.readPublishedRepresentationText(page.representation_token),
  ));
}

async function pathlessPublicEntrypoint(): Promise<{
  state: "unassigned" | "inactive" | "active";
  publicPath: string | null;
  introduction: PublicPageContent | null;
}> {
  const route = await pathlessPublicData.entrypoint();
  if (route.state !== "active" || route.route_kind === "asset") {
    return { state: route.state, publicPath: null, introduction: null };
  }
  let bodyMarkdown: string;
  try {
    bodyMarkdown = await storage.readPublishedRepresentationText(route.representation_token);
  } catch {
    return { state: "inactive", publicPath: null, introduction: null };
  }
  return {
    state: "active",
    publicPath: route.public_id,
    introduction: {
      public_id: route.public_id,
      title: route.public_title,
      summary: route.public_summary,
      body_markdown: bodyMarkdown,
      last_edited_at: route.public_last_edited_at,
    },
  };
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: securityHeaders });
}

function publicAssetRequestAllowed(request: Request): boolean {
  return requestMatchesOrigin(request, config.ASSET_ORIGIN)
    && !request.headers.has("cookie")
    && !request.headers.has("authorization");
}

async function pathlessPageResponse(
  publicId: string,
  markdown: boolean,
  route: PathlessPublicActivePageRoute,
): Promise<Response> {
  let bodyMarkdown: string;
  try {
    bodyMarkdown = await storage.readPublishedRepresentationText(route.representation_token);
  } catch {
    return notFound();
  }
  const page = {
    public_id: publicId,
    title: route.public_title,
    summary: route.public_summary,
    body_markdown: bodyMarkdown,
    last_edited_at: route.public_last_edited_at,
  };
  if (markdown) {
    return new Response(renderPublicPageMarkdown(page, {
      siteOrigin: config.APP_ORIGIN,
      assetOrigin: config.ASSET_ORIGIN,
      entrypointPublicPath: null,
    }), {
      headers: {
        ...markdownHeaders,
        link: `<${config.APP_ORIGIN}/p/${publicId}>; rel="canonical"`,
      },
    });
  }
  const content = await renderMarkdown(bodyMarkdown, unavailableResolvers);
  return new Response(renderPublicPageDocument(
    route.public_title,
    content,
    publicId,
    route.public_last_edited_at,
    {
      siteOrigin: config.APP_ORIGIN,
      summary: route.public_summary,
      canonicalPath: route.canonical_path,
      entrypointPublicPath: null,
      pathless: true,
    },
  ), { headers: htmlHeaders });
}

async function pathlessAssetResponse(
  request: Request,
  publicId: string,
  route: PathlessPublicActiveAssetRoute,
): Promise<Response> {
  if (!publicAssetRequestAllowed(request)) return notFound();
  let metadata: { sizeBytes: number; contentHash: string };
  try {
    metadata = await storage.inspectPublishedRepresentation(route.representation_token);
  } catch {
    return notFound();
  }
  const response = await assetContentResponse(request, {
    filename: route.public_filename,
    content_type: route.public_content_type,
    size_bytes: metadata.sizeBytes,
    content_hash: metadata.contentHash,
  }, {
    read: (_reference, range) => storage.readPublishedRepresentation(route.representation_token, range),
  }, true, publicId);
  response.headers.set("cross-origin-resource-policy", "cross-origin");
  return response;
}

async function publicLlmsResponse(full: boolean): Promise<Response> {
  const entrypoint = await pathlessPublicData.entrypoint();
  const pages = await pathlessPublishedPages(full);
  const options = {
    siteOrigin: config.APP_ORIGIN,
    assetOrigin: config.ASSET_ORIGIN,
    entrypointPublicPath: entrypoint.state === "active" && entrypoint.route_kind !== "asset"
      ? entrypoint.public_id
      : null,
  };
  const content = full ? renderLlmsFullTxt(pages, options) : renderLlmsTxt(pages, options);
  return new Response(content, { headers: full ? agentTextHeaders : textHeaders });
}

async function publicSitemapResponse(): Promise<Response> {
  const pages = await pathlessPublishedPages(false);
  return new Response(renderSitemapXml(pages, config.APP_ORIGIN), { headers: xmlHeaders });
}

export const publicApp = new Elysia({ strictPath: true })
  .onError(({ error, code }) => code === "NOT_FOUND"
    ? new Response("Not found", { status: 404, headers: securityHeaders })
    : routeError(error))
  .get("/health", () => json({ status: "ok", service: "public-web" }))
  .get("/a/*", async ({ request, params }) => {
    if (!publicAssetRequestAllowed(request)) return notFound();
    const parsed = pathlessPublicRouteSchema.safeParse(`/a/${params["*"]}`);
    if (!parsed.success) return notFound();
    const route = await pathlessPublicData.resolve(parsed.data);
    if (route.state === "active" && route.route_kind === "asset") {
      return pathlessAssetResponse(request, route.public_id, route);
    }
    return notFound();
  })
  .get("/robots.txt", () => new Response(renderRobotsTxt(config.APP_ORIGIN), { headers: textHeaders }))
  .get("/sitemap.xml", () => publicSitemapResponse())
  .get("/llms.txt", () => publicLlmsResponse(false))
  .get("/llms-full.txt", () => publicLlmsResponse(true))
  .get("/p", () => new Response(null, {
    status: 308,
    headers: { ...securityHeaders, location: "/p/" },
  }))
  .get("/p/*", async ({ params }) => {
    const rawPath = params["*"];
    if (rawPath === "") {
      const entrypoint = await pathlessPublicData.entrypoint();
      return entrypoint.state === "active" && entrypoint.route_kind !== "asset"
        ? new Response(null, {
            status: 302,
            headers: { ...securityHeaders, location: entrypoint.canonical_path },
          })
        : notFound();
    }
    const markdown = rawPath.endsWith(".md");
    const parsed = pathlessPublicRouteSchema.safeParse(`/p/${rawPath}`);
    if (!parsed.success) return notFound();
    const route = await pathlessPublicData.resolve(parsed.data);
    return route.state === "active" && route.route_kind !== "asset"
      ? pathlessPageResponse(route.public_id, markdown, route)
      : notFound();
  })
  .get("/", async () => {
    const entrypoint = await pathlessPublicEntrypoint();
    const profileLinks = entrypoint.introduction
      ? externalProfileLinks(entrypoint.introduction.body_markdown, config.APP_ORIGIN)
      : [];
    return new Response(renderPublicLandingDocument({
      siteOrigin: config.APP_ORIGIN,
      introduction: entrypoint.introduction,
      entrypointPublicPath: entrypoint.publicPath,
      profileLinks,
    }), { headers: htmlHeaders });
  })
  .get("/public.css", () => new Response(publicPageStyles, {
    headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
  }))
  .get("/content.css", () => new Response(IMAGE_LAYOUT_STYLES, {
    headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
  }));
