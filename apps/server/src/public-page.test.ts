import { describe, expect, test } from "bun:test";
import {
  IMAGE_LAYOUT_STYLES,
  publicPageStyles,
  renderPublicLandingDocument,
  renderPublicPageDocument,
} from "./public-page.ts";

describe("public page presentation", () => {
  test("adds only the compact context-use footnote to knowledge pages", () => {
    const html = renderPublicPageDocument("Public notes", "<h1>Hello</h1>");

    expect(html).toContain("<article><h1>Hello</h1></article><footer class=\"context-use-footnote\">");
    expect(html).toContain('<a href="/llms.txt" type="text/plain">AI-readable site index</a>');
    expect(html).toContain('<p class="context-use-credit">self-hosted with ❤️ using <a class="external-link" href="https://github.com/massimoalbarello/context-use" target="_blank" rel="noopener noreferrer" title="External link (opens in a new tab)">context-use</a>.</p>');
    expect(html).not.toContain("private by default");
    expect(html).not.toContain("MCP");
  });

  test("escapes document metadata while preserving sanitized page content", () => {
    const html = renderPublicPageDocument(
      "Notes </title><script>alert(1)</script>",
      "<p>Already sanitized content</p>",
      "notes",
    );

    expect(html).toContain("<title>Notes &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; | localhost:3000 public knowledge</title>");
    expect(html).toContain('<li aria-current="page"><span class="breadcrumb-separator" aria-hidden="true">/</span>Notes &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</li>');
    expect(html).toContain('name="description" content="Published knowledge from localhost:3000 public knowledge."');
    expect(html).toContain('rel="canonical" href="http://localhost:3000/p/notes"');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"WebPage"');
    expect(html).not.toContain('"name":"Notes </title>');
    expect(html).toContain("<p>Already sanitized content</p>");
    expect(html).toContain('<link rel="stylesheet" href="/content.css">');
  });

  test("keeps the page title and summary out of the published body", () => {
    const html = renderPublicPageDocument(
      "Intro",
      "<p>Biography body.</p>",
      "about/intro",
      undefined,
      {
        siteOrigin: "https://massimo.example",
        summary: "Massimo Albarello's introduction: a builder from Como.",
        introduction: { title: "Intro", summary: "Massimo Albarello's introduction: a builder from Como." },
      },
    );

    expect(html).toContain('<nav class="knowledge-navigation"');
    expect(html).toContain("</nav><article><p>Biography body.</p></article>");
    expect(html).not.toContain("public-page-header");
    expect(html).not.toContain("<h1>");
    expect(html).toContain('name="description" content="Massimo Albarello&#39;s introduction: a builder from Como."');
  });

  test("does not derive navigation from a public identifier", () => {
    const html = renderPublicPageDocument("Como", "<p>Story</p>", "about/chapters/como");

    expect(html).toContain('<nav class="knowledge-navigation" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>');
    expect(html).toContain('<li aria-current="page"><span class="breadcrumb-separator" aria-hidden="true">/</span>Como</li></ol></nav>');
    expect(html).not.toContain('<a href="/p/">Knowledge</a>');
    expect(html).not.toContain('<a href="/p/about/">');
    expect(html).not.toContain('<a href="/p/about/chapters/">');
  });

  test("uses hyperlink-first navigation for public pages", () => {
    const publicId = "11111111-1111-4111-8111-111111111111";
    const html = renderPublicPageDocument(
      "Opaque public page",
      "<p>Follow the links in this page.</p>",
      publicId,
      "2026-08-23T12:00:00Z",
      {
        siteOrigin: "https://massimo.example",
        summary: "A canonical public page.",
        canonicalPath: `/p/${publicId}`,
        entrypointPublicPath: null,
      },
    );

    expect(html).toContain('<nav class="knowledge-navigation" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li>');
    expect(html).not.toContain('<a href="/p/">Knowledge</a>');
    expect(html).not.toContain("11111111</a>");
    expect(html).toContain(`href="/p/${publicId}.md"`);
    expect(html).toContain(`rel="canonical" href="https://massimo.example/p/${publicId}"`);
  });

  test("shows the published version edit date after the page content", () => {
    const html = renderPublicPageDocument(
      "Public notes",
      "<h1>Hello</h1>",
      "notes",
      "2026-07-21T13:45:00.000Z",
    );

    expect(html).toContain('<article><h1>Hello</h1></article><footer class="context-use-footnote"><p class="context-use-credit">');
    expect(html).toContain('<span class="page-last-edited"><strong>Last edited</strong> <time datetime="2026-07-21T13:45:00.000Z">21 July 2026</time></span>');
    expect(html).toContain('<span class="footer-separator" aria-hidden="true">·</span><a href="/p/notes.md" type="text/markdown">View as Markdown</a>');
  });

  test("identifies a published introduction as a canonical biography", () => {
    const introduction = {
      title: "Intro",
      summary: "Massimo Albarello's introduction: a builder from Como.",
    };
    const html = renderPublicPageDocument(
      introduction.title,
      "<p>Biography body.</p>",
      "about/intro",
      "2026-08-07T11:25:59.777Z",
      {
        siteOrigin: "https://massimo.example",
        summary: introduction.summary,
        introduction,
        profileLinks: ["https://github.com/massimoalbarello"],
      },
    );

    expect(html).toContain("<title>Massimo Albarello — Biography</title>");
    expect(html).toContain('rel="canonical" href="https://massimo.example/p/about/intro"');
    expect(html).toContain('property="og:type" content="profile"');
    expect(html).toContain('"@type":"ProfilePage"');
    expect(html).toContain('"mainEntity":{"@id":"https://massimo.example/p/about/intro#person"}');
    expect(html).toContain('"@type":"Person"');
    expect(html).toContain('"sameAs":["https://github.com/massimoalbarello"]');
    expect(html).toContain('"dateModified":"2026-08-07T11:25:59.777Z"');
  });

  test("renders the first-person billboard and optional introduction link", () => {
    const html = renderPublicLandingDocument({
      siteOrigin: "https://massimo.example",
      introduction: {
        title: "Intro",
        summary: "Massimo Albarello's introduction: a builder from Como.",
      },
      entrypointPublicPath: "about/intro",
      profileLinks: ["https://github.com/massimoalbarello"],
    });

    expect(html).toContain("<title>Massimo Albarello&#39;s public knowledge</title>");
    expect(html).toContain("Massimo Albarello’s public context.");
    expect(html).toContain("Massimo Albarello&#39;s introduction: a builder from Como.");
    expect(html).toContain('href="/p/about/intro"');
    expect(html).toContain("Read my biography");
    expect(html).not.toContain("Browse all published knowledge");
    expect(html).toContain('rel="canonical" href="https://massimo.example/"');
    expect(html).toContain('"@type":"Person"');
    expect(html).toContain('"name":"Massimo Albarello"');
    expect(html).toContain('"sameAs":["https://github.com/massimoalbarello"]');
    expect(html).toContain('<a href="/llms.txt" type="text/plain">AI-readable site index</a>');
    expect(html).toContain('<p class="landing-credit">self-hosted with ❤️ using');
    expect(html).not.toContain("MCP");
  });

  test("does not offer a dead directory index when no entry point is configured", () => {
    const html = renderPublicLandingDocument({ siteOrigin: "https://someone.example" });

    expect(html).not.toContain('class="landing-cta"');
    expect(html).not.toContain('href="/p/"');
    expect(html).toContain("A public billboard<br>for what I choose to share.");
    expect(html).toContain("<title>someone.example public knowledge</title>");
    expect(html).not.toContain('"@type":"Person"');
  });

  test("does not require an optional contacts page for profile identity", () => {
    const html = renderPublicLandingDocument({
      siteOrigin: "https://massimo.example",
      introduction: {
        title: "Intro",
        summary: "Massimo Albarello's introduction: a builder from Como.",
      },
    });

    expect(html).toContain('"@type":"Person"');
    expect(html).toContain('"name":"Massimo Albarello"');
    expect(html).not.toContain('"sameAs"');
  });

  test("binds structured profile identity to the configured entry point", () => {
    const html = renderPublicLandingDocument({
      siteOrigin: "https://massimo.example",
      introduction: {
        title: "Massimo Albarello",
        summary: "Massimo Albarello's public profile.",
      },
      entrypointPublicPath: "start-here",
    });

    expect(html).toContain('"@id":"https://massimo.example/p/start-here#person"');
    expect(html).toContain('"url":"https://massimo.example/p/start-here"');
    expect(html).not.toContain("/p/about/intro#person");
  });

  test("styles the footnote, billboard, and published media", () => {
    expect(publicPageStyles).toContain(".context-use-footnote{");
    expect(publicPageStyles).toContain(".context-use-credit{");
    expect(publicPageStyles).toContain(".context-use-utilities{");
    expect(publicPageStyles).toContain(".knowledge-navigation{");
    expect(publicPageStyles).not.toContain(".public-index");
    expect(publicPageStyles).toContain(".public-landing{");
    expect(publicPageStyles).toContain(":is(h1,h2,h3,h4,h5,h6)[id]{scroll-margin-top:1.5rem}");
    expect(publicPageStyles).toContain('.external-link::after{');
    expect(publicPageStyles).toContain('content:"↗"');
    expect(publicPageStyles).toContain("img,video{max-width:100%");
    expect(publicPageStyles).toContain("video,audio{width:100%}");
    expect(publicPageStyles).toContain("display:flex");
    expect(IMAGE_LAYOUT_STYLES).toContain(".cu-image--layout-half{");
    expect(IMAGE_LAYOUT_STYLES).toContain(".cu-image>img,.cu-image>video{");
    expect(IMAGE_LAYOUT_STYLES).toContain(".cu-image--shape-square>video");
    expect(IMAGE_LAYOUT_STYLES).toContain("object-fit:cover");
    expect(IMAGE_LAYOUT_STYLES).toContain("@media(max-width:640px)");
  });
});
