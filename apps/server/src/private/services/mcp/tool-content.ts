export const jsonContent = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export const jsonObjectContent = (value: object) => ({
  ...jsonContent(value),
  structuredContent: value as Record<string, unknown>,
});

// biome-ignore lint/complexity/useMaxParams: This low-level MCP response primitive mirrors the SDK shape.
export const textContent = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true as const } : {}),
});
