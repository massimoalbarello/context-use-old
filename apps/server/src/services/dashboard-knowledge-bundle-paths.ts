export const stagedBundleKey = (intentId: string) => `bundles/${intentId}.cuse`;

export const importPartKey = ({ importId, partNumber }: { importId: string; partNumber: number }) =>
  `imports/${importId}/parts/${partNumber}`;

export const bundleFilename = () =>
  `context-use-knowledge-${new Date().toISOString().slice(0, 10)}.cuse`;

export const exportStatusUrl = (intentId: string) =>
  `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/status`;

export const exportDownloadUrl = (intentId: string) =>
  `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/download`;

export const importStatusUrl = (importId: string) =>
  `/api/dashboard/knowledge-imports/${encodeURIComponent(importId)}/status`;
