import { describe, expect, test } from "bun:test";
import { config } from "./config.ts";
import { publicationWarnings, renderMarkdown, type MarkdownResolvers } from "./markdown.ts";

const unavailableResolvers: MarkdownResolvers = {
  object: async () => ({ available: false }),
};

function assetResolvers(contentType = "image/png"): MarkdownResolvers {
  return {
    object: async (id) => ({
      available: true,
      representation: "asset",
      href: `/api/dashboard/assets/${id}/content`,
      contentType,
    }),
  };
}

describe("safe Markdown rendering", () => {
  test("adds deterministic, duplicate-safe anchors to Markdown headings", async () => {
    const html = await renderMarkdown(
      "## A Useful Section\n\n### Résumé & next steps\n\n## A Useful Section",
      unavailableResolvers,
    );

    expect(html).toContain('<h2 id="a-useful-section">A Useful Section</h2>');
    expect(html).toContain('<h3 id="resume-next-steps">Résumé &amp; next steps</h3>');
    expect(html).toContain('<h2 id="a-useful-section-2">A Useful Section</h2>');
  });

  test("scans public metadata and canonical or retained object references", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(publicationWarnings("Safe body", ["Safe title", "secret = summary-canary"]))
      .toContain("Possible secret material detected; review the page carefully");
    expect(publicationWarnings("Safe body", ["https://example.com", "Safe summary"]))
      .toContain("1 external URL(s) will become public");
    expect(publicationWarnings(`[Related](context-use://object/${id})`))
      .toContain("1 context-use reference(s) have independent visibility");
    expect(publicationWarnings(`[Older](context-use://document/${id})`))
      .toContain("1 context-use reference(s) have independent visibility");
    expect(publicationWarnings(`[Old](context-use://page/${id})`))
      .toContain("1 context-use reference(s) have independent visibility");
    expect(publicationWarnings(`[Directory](context-use://directory/${id})`))
      .not.toContain("1 context-use reference(s) have independent visibility");
  });

  test("removes scripts, event handlers, unsafe URLs, and remote inline media", async () => {
    const html = await renderMarkdown(
      `<script>alert(1)</script>\n<a href="javascript:alert(1)" onclick="alert(1)">bad</a>\n![remote](https://attacker.example/pixel.png)\n<video src="https://attacker.example/video.mp4" autoplay></video>`,
      unavailableResolvers,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("attacker.example");
  });

  test("renders canonical object identities according to their representation", async () => {
    const page = "11111111-1111-4111-8111-111111111111";
    const record = "22222222-2222-4222-8222-222222222222";
    const asset = "33333333-3333-4333-8333-333333333333";
    const html = await renderMarkdown([
      `[Page](context-use://object/${page}#details)`,
      `[Record](context-use://object/${record})`,
      `![Photo](context-use://object/${asset})`,
      `[Download](context-use://object/${asset})`,
    ].join("\n\n"), {
      object: async (id) => {
        if (id === asset) {
          return {
            available: true,
            representation: "asset",
            href: `/api/dashboard/assets/${asset}/content`,
            contentType: "image/png",
          };
        }
        if (id === page || id === record) {
          return {
            available: true,
            representation: id === page ? "page" : "record",
            href: `/app/objects/${id}`,
          };
        }
        return { available: false };
      },
    });

    expect(html).toContain(`<a href="/app/objects/${page}#details">Page</a>`);
    expect(html).toContain(`<a href="/app/objects/${record}">Record</a>`);
    expect(html).toContain(`<img src="/api/dashboard/assets/${asset}/content" alt="Photo" loading="lazy"`);
    expect(html).toContain(`<a href="/api/dashboard/assets/${asset}/content" target="_blank" rel="noopener noreferrer">Download</a>`);
    expect(html).not.toContain("context-use://");
  });

  test("keeps links from immutable legacy revisions clickable in dashboard previews", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const html = await renderMarkdown([
      `[Older page](context-use://document/${first}#Details)`,
      `[Dashboard page](/app/pages/${second})`,
    ].join("\n\n"), {
      object: async (id) => ({
        available: true,
        representation: "page",
        href: `/app/objects/${id}`,
      }),
    });

    expect(html).toContain(`<a href="/app/objects/${first}#details">Older page</a>`);
    expect(html).toContain(`<a href="/app/objects/${second}">Dashboard page</a>`);
    expect(html).not.toContain("Private reference");
    expect(html).not.toContain("context-use://");
  });

  test("embeds safe images and videos while rendering PDFs as links", async () => {
    const image = "11111111-1111-4111-8111-111111111111";
    const video = "22222222-2222-4222-8222-222222222222";
    const pdf = "33333333-3333-4333-8333-333333333333";
    const types = new Map([[image, "image/png"], [video, "video/mp4"], [pdf, "application/pdf"]]);
    const html = await renderMarkdown([
      `![A photo](context-use://object/${image})`,
      `![A demo](context-use://object/${video})`,
      `![](context-use://object/${pdf})`,
    ].join("\n\n"), {
      object: async (id) => ({
        available: true,
        representation: "asset",
        href: `/api/dashboard/assets/${id}/content`,
        contentType: types.get(id) ?? "application/octet-stream",
      }),
    });

    expect(html).toContain(`<img src="/api/dashboard/assets/${image}/content" alt="A photo" loading="lazy"`);
    expect(html).toContain(`<video src="/api/dashboard/assets/${video}/content" controls preload="metadata" aria-label="A demo">`);
    expect(html).toContain(`<a href="/api/dashboard/assets/${pdf}/content" target="_blank" rel="noopener noreferrer">Open PDF</a>`);
  });

  test("renders supported media formatting without admitting authored styles", async () => {
    const asset = "11111111-1111-4111-8111-111111111111";
    const valid = await renderMarkdown(
      `![Portrait](context-use://object/${asset}){size=small align=right shape=square layout=half}`,
      assetResolvers("image/jpeg"),
    );
    const invalid = await renderMarkdown(
      `![Typo](context-use://object/${asset}){algin=center style=display:none}`,
      assetResolvers(),
    );

    expect(valid).toContain("cu-image--size-small cu-image--align-right cu-image--shape-square cu-image--layout-half");
    expect(invalid).toContain("{algin=center style=display:none}");
    expect(invalid).not.toContain("cu-image");
    expect(invalid).not.toContain('display:none"');
  });

  test("keeps adjacent formatted media as sibling elements", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const html = await renderMarkdown(
      `![First](context-use://object/${first}){layout=half}\n![Second](context-use://object/${second}){layout=half}`,
      assetResolvers("image/webp"),
    );

    expect(html.match(/<span class="[^"]*cu-image--layout-half[^"]*">/g)).toHaveLength(2);
    expect(html).toContain("<p><span");
  });

  test("keeps the UUID-free adopted public-asset representation", async () => {
    const href = `${config.ASSET_ORIGIN}/a/media/published-photo`;
    const html = await renderMarkdown(
      "![Projected](context-use://public-asset/media/published-photo){shape=square}",
      {
        ...unavailableResolvers,
        publicAssetPath: async (path) => path === "media/published-photo"
          ? { available: true, href, contentType: "image/webp" }
          : { available: false },
      },
    );

    expect(html).toContain(`<img src="${href}" alt="Projected" loading="lazy">`);
    expect(html).not.toContain("context-use://");
  });

  test("keeps unavailable and non-asset embedded objects inert", async () => {
    const page = "11111111-1111-4111-8111-111111111111";
    const missing = "22222222-2222-4222-8222-222222222222";
    const html = await renderMarkdown([
      `![Not media](context-use://object/${page})`,
      `[Private record](context-use://object/${missing}#secret)`,
      `[Older missing page](context-use://document/${missing})`,
    ].join("\n\n"), {
      object: async (id) => id === page
        ? { available: true, representation: "page", href: `/app/objects/${page}` }
        : { available: false },
    });

    expect(html).toContain("Private asset unavailable");
    expect(html).toContain('<span class="private-reference">Private record</span>');
    expect(html).toContain('<span class="private-reference">Older missing page</span>');
    expect(html).not.toContain("[Older missing page]");
    expect(html).not.toContain("#secret");
    expect(html).not.toContain(page);
    expect(html).not.toContain(missing);
  });

  test("does not resolve private identities without an object representation", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    let lookups = 0;
    const html = await renderMarkdown([
      `[Directory](context-use://directory/${id})`,
      `[Dashboard](/app/directories/${id})`,
      "[[about/intro|Wiki path]]",
    ].join("\n\n"), {
      object: async () => {
        lookups += 1;
        return { available: false };
      },
    });

    expect(lookups).toBe(0);
    expect(html).not.toContain(id);
    expect(html).not.toContain("context-use://");
    expect(html).not.toContain("/app/pages/");
    expect(html).not.toContain("href=");
  });

  test("marks only links that leave the application as external", async () => {
    const html = await renderMarkdown(
      `[Knowledge](/p/notes) [Same origin](${config.APP_ORIGIN}/p/about) [External](https://example.com/notes) [Email](mailto:reader@example.com)`,
      unavailableResolvers,
    );

    expect(html).toContain('<a href="/p/notes">Knowledge</a>');
    expect(html).toContain(`<a href="${config.APP_ORIGIN}/p/about">Same origin</a>`);
    expect(html).toContain('<a href="https://example.com/notes" class="external-link" rel="noopener noreferrer" target="_blank" title="External link (opens in a new tab)">External</a>');
    expect(html).toContain('<a href="mailto:reader@example.com" class="external-link" rel="noopener noreferrer" target="_blank" title="External link (opens in a new tab)">Email</a>');
  });

  test("keeps hand-written media only for canonical asset routes", async () => {
    const video = "22222222-2222-4222-8222-222222222222";
    const html = await renderMarkdown(
      `<video src="/api/dashboard/assets/${video}/content" autoplay></video>`,
      unavailableResolvers,
    );

    expect(html).toContain(`<video src="/api/dashboard/assets/${video}/content" controls preload="metadata"></video>`);
    expect(html).not.toContain("autoplay");
  });
});
