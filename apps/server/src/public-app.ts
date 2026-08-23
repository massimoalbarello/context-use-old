import {
  mapConcurrently,
  PathlessPublicRepository,
  PublicRepository,
  createPool,
  type PathlessPublicActiveAssetRoute,
  type PathlessPublicActivePageRoute,
} from "@context-use/database";
import { AssetPath, DirectoryPath, PagePath } from "@context-use/shared";
import { Elysia } from "elysia";
import { config } from "./config.ts";
import { json, routeError } from "./http.ts";
import { renderMarkdown } from "./markdown.ts";
import { createPublicAssetContentHandler } from "./public-asset-content.ts";
import { renderLlmsFullTxt, renderLlmsTxt, renderPublicPageMarkdown } from "./public-llms.ts";
import {
  OPTIONAL_CONTACTS_PATH,
  externalProfileLinks,
  renderRobotsTxt,
  renderSitemapXml,
} from "./public-discovery.ts";
import {
  IMAGE_LAYOUT_STYLES,
  publicPageStyles,
  publicPageHref,
  renderPublicIndexDocument,
  renderPublicLandingDocument,
  renderPublicPageDocument,
} from "./public-page.ts";
import { requestMatchesOrigin, securityHeaders } from "./security.ts";
import { BrokeredStorage } from "./storage-client.ts";
import { assetContentResponse } from "./asset-content.ts";

const pool = createPool(config.PUBLIC_DATABASE_URL, { application_name: "context-use-public-web" });
const publicData = new PublicRepository(pool);
const pathlessPublicData = new PathlessPublicRepository(pool);
const storage = new BrokeredStorage({
  socketPath: config.STORAGE_SOCKET_PATH,
  token: config.STORAGE_PUBLIC_TOKEN,
  publicOnly: true,
});
const publicAssetContent = createPublicAssetContentHandler(publicData, storage, config.ASSET_ORIGIN);
const canonicalPublicId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
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
    const parsed = AssetPath.safeParse(path);
    if (!parsed.success) return { available: false as const };
    const asset = await publicData.assetByPublicPath(parsed.data);
    return asset
      ? {
          available: true as const,
          href: `${config.ASSET_ORIGIN}/a/${asset.public_path}`,
          contentType: asset.content_type,
        }
      : { available: false as const };
  },
};

async function publishedPage(path: string) {
  const page = await publicData.pageByPublicPath(path);
  if (!page) return null;
  return { ...page, body_markdown: await storage.readPublishedDocument(page.public_path) };
}

async function publishedPages() {
  const pages = await publicData.publishedPages();
  return mapConcurrently(pages, 8, async (page) => ({
    ...page,
    body_markdown: await storage.readPublishedDocument(page.public_path),
  }));
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
    public_path: publicId,
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

async function publicEntrypoint() {
  const settings = await publicData.settings();
  const introduction = settings.entrypoint_public_path
    ? await publishedPage(settings.entrypoint_public_path)
    : null;
  return { settings, introduction };
}

async function publicDirectoryResponse(rawPath: string): Promise<Response> {
  const parsedPath = DirectoryPath.safeParse(rawPath);
  if (!parsedPath.success) return new Response("Not found", { status: 404, headers: securityHeaders });
  const [index, entrypoint] = await Promise.all([
    publicData.directoryIndex(parsedPath.data),
    publicEntrypoint(),
  ]);
  if (!index && parsedPath.data !== "") {
    return new Response("Not found", { status: 404, headers: securityHeaders });
  }
  const renderedIndex = index ?? {
    path: "",
    title: "Knowledge",
    summary: "No knowledge has been published yet.",
    default_page_path: null,
    entries: [],
  };
  const defaultPageHref = publicPageHref(renderedIndex.default_page_path);
  if (defaultPageHref) {
    return new Response(null, {
      status: 302,
      headers: { ...securityHeaders, location: defaultPageHref },
    });
  }
  return new Response(renderPublicIndexDocument({
    ...renderedIndex,
    siteOrigin: config.APP_ORIGIN,
    introduction: entrypoint.introduction,
    entrypointPublicPath: entrypoint.settings.entrypoint_public_path,
  }), { headers: htmlHeaders });
}

async function publicLlmsResponse(full: boolean): Promise<Response> {
  const [pages, settings] = await Promise.all([
    full ? publishedPages() : publicData.publishedPages(),
    publicData.settings(),
  ]);
  const options = {
    siteOrigin: config.APP_ORIGIN,
    assetOrigin: config.ASSET_ORIGIN,
    entrypointPublicPath: settings.entrypoint_public_path,
  };
  const content = full ? renderLlmsFullTxt(pages, options) : renderLlmsTxt(pages, options);
  return new Response(content, { headers: full ? agentTextHeaders : textHeaders });
}

async function publicSitemapResponse(): Promise<Response> {
  const pages = await publicData.publishedPages();
  return new Response(renderSitemapXml(pages, config.APP_ORIGIN), { headers: xmlHeaders });
}

async function optionalProfileLinks(): Promise<string[]> {
  const contacts = await publishedPage(OPTIONAL_CONTACTS_PATH);
  return contacts
    ? externalProfileLinks(contacts.body_markdown, config.APP_ORIGIN)
    : [];
}

export const publicApp = new Elysia({ strictPath: true })
  .onError(({ error, code }) => code === "NOT_FOUND"
    ? new Response("Not found", { status: 404, headers: securityHeaders })
    : routeError(error))
  .get("/health", () => json({ status: "ok", service: "public-web" }))
  .get("/a/*", async ({ request, params }) => {
    const publicId = params["*"];
    if (!canonicalPublicId.test(publicId)) return publicAssetContent(request, publicId);
    if (!publicAssetRequestAllowed(request)) return notFound();
    const route = await pathlessPublicData.resolve(`/a/${publicId}`);
    if (route.state === "active" && route.route_kind === "asset") {
      return pathlessAssetResponse(request, publicId, route);
    }
    return route.state === "unassigned"
      ? publicAssetContent(request, publicId)
      : notFound();
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
    if (rawPath === "") return publicDirectoryResponse("");
    if (rawPath.endsWith("/")) return publicDirectoryResponse(rawPath.slice(0, -1));
    const markdown = rawPath.endsWith(".md");
    const pathlessPublicId = markdown ? rawPath.slice(0, -3) : rawPath;
    if (canonicalPublicId.test(pathlessPublicId)) {
      const route = await pathlessPublicData.resolve(`/p/${pathlessPublicId}${markdown ? ".md" : ""}`);
      if (route.state === "active" && route.route_kind !== "asset") {
        return pathlessPageResponse(pathlessPublicId, markdown, route);
      }
      if (route.state === "inactive") return notFound();
    }
    const parsedPath = PagePath.safeParse(markdown ? rawPath.slice(0, -3) : rawPath);
    if (!parsedPath.success) return new Response("Not found", { status: 404, headers: securityHeaders });
    const publicPath = parsedPath.data;
    const page = await publishedPage(publicPath);
    if (!page) {
      if (markdown) return new Response("Not found", { status: 404, headers: securityHeaders });
      const index = await publicData.directoryIndex(publicPath);
      if (!index) return new Response("Not found", { status: 404, headers: securityHeaders });
      const defaultPageHref = publicPageHref(index.default_page_path);
      return new Response(null, {
        status: defaultPageHref ? 302 : 308,
        headers: {
          ...securityHeaders,
          location: defaultPageHref ?? `/p/${publicPath}/`,
        },
      });
    }
    if (markdown) {
      return new Response(renderPublicPageMarkdown(page, {
        siteOrigin: config.APP_ORIGIN,
        assetOrigin: config.ASSET_ORIGIN,
      }), {
        headers: {
          ...markdownHeaders,
          link: `<${config.APP_ORIGIN}/p/${page.public_path}>; rel="canonical"`,
        },
      });
    }
    const settings = await publicData.settings();
    const introduction = publicPath === settings.entrypoint_public_path
      ? page
      : settings.entrypoint_public_path
        ? await publishedPage(settings.entrypoint_public_path)
        : null;
    const profileLinks = publicPath === settings.entrypoint_public_path
      ? await optionalProfileLinks()
      : undefined;
    // The database projection has already removed every private identifier and
    // replaced independently public targets with public paths. The renderer can
    // resolve a published asset path but has no UUID/private-path capability.
    const content = await renderMarkdown(page.body_markdown, unavailableResolvers);
    return new Response(renderPublicPageDocument(
      page.title,
      content,
      page.public_path,
      page.last_edited_at,
      {
        siteOrigin: config.APP_ORIGIN,
        summary: page.summary,
        introduction,
        profileLinks,
        entrypointPublicPath: settings.entrypoint_public_path,
      },
    ), { headers: htmlHeaders });
  })
  .get("/", async () => {
    const [entrypoint, profileLinks] = await Promise.all([
      publicEntrypoint(),
      optionalProfileLinks(),
    ]);
    return new Response(renderPublicLandingDocument({
      siteOrigin: config.APP_ORIGIN,
      introduction: entrypoint.introduction,
      entrypointPublicPath: entrypoint.settings.entrypoint_public_path,
      profileLinks,
    }), { headers: htmlHeaders });
  })
  .get("/public.css", () => new Response(publicPageStyles, {
    headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
  }))
  .get("/content.css", () => new Response(IMAGE_LAYOUT_STYLES, {
    headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
  }));
