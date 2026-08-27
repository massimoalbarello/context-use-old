import { Elysia } from "elysia";
import { IMAGE_LAYOUT_STYLES, publicPageStyles } from "#public/views/page-view.ts";

export function createPublicStylesController(securityHeaders: Record<string, string>) {
  return new Elysia()
    .get("/public.css", () => stylesheet({ content: publicPageStyles, securityHeaders }))
    .get("/content.css", () => stylesheet({ content: IMAGE_LAYOUT_STYLES, securityHeaders }));
}

function stylesheet({
  content,
  securityHeaders,
}: {
  content: string;
  securityHeaders: Record<string, string>;
}): Response {
  return new Response(content, {
    headers: { ...securityHeaders, "content-type": "text/css; charset=utf-8" },
  });
}
