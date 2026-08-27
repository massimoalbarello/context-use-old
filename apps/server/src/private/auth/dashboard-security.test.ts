import { describe, expect, test } from "bun:test";
import { requestMatchesOrigin } from "#http/request-origin.ts";
import { SecurityError } from "#http/security-error.ts";
import { createSecurityHeaders } from "#http/security-headers.ts";
import type { DashboardPrincipal } from "./auth-engine.ts";
import { createDashboardSecurity } from "./dashboard-security.ts";

const appOrigin = "http://localhost:3000";
const assetOrigin = "http://assets.localhost:3000";
const security = createDashboardSecurity({
  appOrigin,
  csrfSecret: "test-dashboard-csrf-secret-that-is-long-enough",
});
const principal: DashboardPrincipal = {
  userId: "owner",
  sessionId: "session",
  email: "owner@example.com",
};

function mutation(headers: Record<string, string>) {
  return new Request(`${appOrigin}/api/dashboard/pages`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("dashboard mutation boundary", () => {
  test("allows published media from the dedicated asset origin", () => {
    expect(createSecurityHeaders(assetOrigin)["content-security-policy"]).toContain(
      `media-src 'self' blob: ${assetOrigin}`,
    );
  });

  test("matches the configured host through the trusted TLS reverse proxy", () => {
    expect(
      requestMatchesOrigin({
        request: new Request("http://context.example/api/dashboard/pages", {
          headers: { "x-forwarded-proto": "https" },
        }),
        expectedOrigin: "https://context.example",
      }),
    ).toBe(true);
    expect(
      requestMatchesOrigin({
        request: new Request("http://assets.context.example/api/dashboard/pages", {
          headers: { "x-forwarded-proto": "https" },
        }),
        expectedOrigin: "https://context.example",
      }),
    ).toBe(false);
  });

  test("accepts the same session's CSRF token with exact browser metadata", () => {
    expect(() =>
      security.assertDashboardRequestSecurity({
        request: mutation({
          origin: appOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "x-csrf-token": security.csrfToken(principal),
        }),
        principal,
      }),
    ).not.toThrow();
  });

  for (const [name, headers] of [
    [
      "missing origin",
      {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-csrf-token": security.csrfToken(principal),
      },
    ],
    [
      "hostile origin",
      {
        origin: "https://attacker.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-csrf-token": security.csrfToken(principal),
      },
    ],
    [
      "missing Fetch Metadata",
      {
        origin: appOrigin,
        "content-type": "application/json",
        "x-csrf-token": security.csrfToken(principal),
      },
    ],
    [
      "cross-site Fetch Metadata",
      {
        origin: appOrigin,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        "x-csrf-token": security.csrfToken(principal),
      },
    ],
    [
      "missing CSRF",
      { origin: appOrigin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    ],
    [
      "non-JSON body",
      {
        origin: appOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
        "x-csrf-token": security.csrfToken(principal),
      },
    ],
  ] as const) {
    test(`rejects ${name}`, () => {
      expect(() =>
        security.assertDashboardRequestSecurity({ request: mutation(headers), principal }),
      ).toThrow(SecurityError);
    });
  }

  test("accepts a checksum-bound same-origin file upload without requiring JSON", () => {
    const request = new Request(
      `${appOrigin}/api/dashboard/assets/11111111-1111-4111-8111-111111111111/content`,
      {
        method: "PUT",
        headers: {
          origin: appOrigin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/pdf",
          "x-csrf-token": security.csrfToken(principal),
        },
        body: "pdf bytes",
      },
    );
    expect(() => security.assertDashboardUploadSecurity({ request, principal })).not.toThrow();
  });
});
