import type { ByteRange, GeneratedBlobMetadata, BlobStorage, StoredBlob } from "./storage.ts";
import { AssetNotFoundError } from "./storage.ts";

type StorageClientOptions = {
  socketPath: string;
  token: string;
  publicOnly?: boolean;
};

async function socketFetch(
  socketPath: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null } = {},
): Promise<Response> {
  const requestInit = {
    method: init.method ?? "GET",
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body !== undefined ? { body: init.body as BodyInit | null } : {}),
  };
  const local = (globalThis as typeof globalThis & {
    __contextUseStorageHandler?: (request: Request) => Promise<Response> | Response;
  }).__contextUseStorageHandler;
  return local
    ? local(new Request(`http://context-use-storage${path}`, requestInit))
    : fetch(`http://localhost${path}`, { unix: socketPath, ...requestInit });
}

async function markdownResponseText(response: Response): Promise<string> {
  // Response.text() strips a leading UTF-8 BOM. Knowledge body hashes cover
  // the exact PostgreSQL text bytes, so preserve U+FEFF when it is present.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
}

export class BrokeredStorage implements BlobStorage {
  constructor(private readonly options: StorageClientOptions) {}

  private async request(path: string, init: Parameters<typeof socketFetch>[2] = {}): Promise<Response> {
    return socketFetch(this.options.socketPath, path, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(init.headers ?? {}),
      },
    });
  }

  async write(asset: StoredBlob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request("/private/blob", {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(asset.sizeBytes),
        "x-asset-id": asset.id,
        "x-blob-key": asset.blobKey,
        "x-filename": encodeURIComponent(asset.filename),
        "x-content-type": asset.contentType,
        "x-content-sha256": asset.contentHash,
      },
      body,
    });
    if (!response.ok) throw new Error(`Storage write failed (${response.status})`);
  }

  async writeMarkdownBlob(input: {
    revisionId: string;
    blobKey: string;
    sizeBytes: number;
    contentHash: string;
    body: string;
  }): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request("/private/markdown-blob", {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": String(input.sizeBytes),
        "x-page-revision-id": input.revisionId,
        "x-blob-key": input.blobKey,
        "x-content-sha256": input.contentHash,
      },
      body: new Blob([input.body]).stream(),
    });
    if (!response.ok) throw new Error(`Markdown blob write failed (${response.status})`);
  }

  async readMarkdownBlob(blobKey: string): Promise<string> {
    if (this.options.publicOnly) throw new Error("Private knowledge is unavailable");
    const response = await this.request(`/private/markdown-blob?key=${encodeURIComponent(blobKey)}`);
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok) throw new Error(`Markdown blob read failed (${response.status})`);
    return markdownResponseText(response);
  }

  async readPublishedPage(publicPath: string): Promise<string> {
    if (!this.options.publicOnly) throw new Error("Published page reads require a public-only client");
    const response = await this.request(`/public/page?path=${encodeURIComponent(publicPath)}`);
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok) throw new Error(`Published page read failed (${response.status})`);
    return markdownResponseText(response);
  }

  async readPublishedRepresentation(representationToken: string, range?: ByteRange): Promise<BodyInit> {
    if (!this.options.publicOnly) throw new Error("Published representation reads require a public-only client");
    const response = await this.request(
      `/public/representation?token=${encodeURIComponent(representationToken)}`,
      { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} },
    );
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok || !response.body) {
      throw new Error(`Published representation read failed (${response.status})`);
    }
    return response.body;
  }

  async readPublishedRepresentationText(representationToken: string): Promise<string> {
    const body = await this.readPublishedRepresentation(representationToken);
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await new Response(body).arrayBuffer());
  }

  async inspectPublishedRepresentation(representationToken: string): Promise<GeneratedBlobMetadata> {
    if (!this.options.publicOnly) throw new Error("Published representation reads require a public-only client");
    const response = await this.request(
      `/public/representation?token=${encodeURIComponent(representationToken)}`,
      { method: "HEAD" },
    );
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok) throw new Error(`Published representation inspection failed (${response.status})`);
    const sizeBytes = Number(response.headers.get("content-length"));
    const contentHash = response.headers.get("x-content-sha256") ?? "";
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error("Published representation returned invalid metadata");
    }
    return { sizeBytes, contentHash };
  }

  async delete(blobKey: string): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request(`/private/blob?key=${encodeURIComponent(blobKey)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Storage deletion failed (${response.status})`);
  }

  async read(blobKey: string, range?: ByteRange): Promise<BodyInit> {
    // Public callers pass an already-public knowledge path; only the broker can
    // translate it into a blob key. Private callers continue to pass the
    // immutable blob key selected by their private metadata repository.
    const query = this.options.publicOnly
      ? `/public/object?path=${encodeURIComponent(blobKey)}`
      : blobKey.startsWith("documents/private/")
        ? `/private/markdown-blob?key=${encodeURIComponent(blobKey)}`
        : `/private/blob?key=${encodeURIComponent(blobKey)}`;
    const response = await this.request(query, {
      headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok || !response.body) throw new Error(`Storage read failed (${response.status})`);
    return response.body;
  }

  async materializePublicationArtifact(allocationId: string): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request(
      `/private/publication-artifact?id=${encodeURIComponent(allocationId)}`,
      { method: "PUT" },
    );
    if (!response.ok) {
      throw new Error(`Publication artifact materialization failed (${response.status})`);
    }
  }

  async verify(blobKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    if (this.options.publicOnly) return false;
    const response = await this.request("/private/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([JSON.stringify({ blob_key: blobKey, size_bytes: sizeBytes, content_hash: contentHash })]).stream(),
    });
    if (!response.ok) return false;
    const result = await response.json() as { verified?: boolean };
    return result.verified === true;
  }
}
