export function createSecurityHeaders(assetOrigin: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `img-src 'self' data: ${assetOrigin}`,
      `media-src 'self' blob: ${assetOrigin}`,
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
    ].join("; "),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
