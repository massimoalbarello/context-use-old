import type { ByteRange, GeneratedObjectMetadata, ObjectStorage, StoredAsset } from "./storage.ts";
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

export class BrokeredStorage implements ObjectStorage {
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

  async write(asset: StoredAsset, body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request("/private/object", {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(asset.sizeBytes),
        "x-asset-id": asset.id,
        "x-object-key": asset.objectKey,
        "x-filename": encodeURIComponent(asset.filename),
        "x-content-type": asset.contentType,
        "x-content-sha256": asset.contentHash,
      },
      body,
    });
    if (!response.ok) throw new Error(`Storage write failed (${response.status})`);
  }

  async writeDocument(input: {
    revisionId: string;
    objectKey: string;
    sizeBytes: number;
    contentHash: string;
    body: string;
  }): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request("/private/document", {
      method: "PUT",
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": String(input.sizeBytes),
        "x-document-revision-id": input.revisionId,
        "x-object-key": input.objectKey,
        "x-content-sha256": input.contentHash,
      },
      body: new Blob([input.body]).stream(),
    });
    if (!response.ok) throw new Error(`Knowledge document write failed (${response.status})`);
  }

  async readDocument(objectKey: string): Promise<string> {
    if (this.options.publicOnly) throw new Error("Private knowledge is unavailable");
    const response = await this.request(`/private/document?key=${encodeURIComponent(objectKey)}`);
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok) throw new Error(`Knowledge document read failed (${response.status})`);
    return markdownResponseText(response);
  }

  async readPublishedDocument(publicPath: string): Promise<string> {
    if (!this.options.publicOnly) throw new Error("Published document reads require a public-only client");
    const response = await this.request(`/public/document?path=${encodeURIComponent(publicPath)}`);
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok) throw new Error(`Published document read failed (${response.status})`);
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

  async inspectPublishedRepresentation(representationToken: string): Promise<GeneratedObjectMetadata> {
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

  async delete(objectKey: string): Promise<void> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request(`/private/object?key=${encodeURIComponent(objectKey)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Storage deletion failed (${response.status})`);
  }

  async read(objectKey: string, range?: ByteRange): Promise<BodyInit> {
    // Public callers pass an already-public knowledge path; only the broker can
    // translate it into an object key. Private callers continue to pass the
    // immutable object key selected by their private metadata repository.
    const query = this.options.publicOnly
      ? `/public/object?path=${encodeURIComponent(objectKey)}`
      : objectKey.startsWith("bundles/")
          ? `/private/bundle?key=${encodeURIComponent(objectKey)}`
          : objectKey.startsWith("imports/")
            ? `/private/import-part?key=${encodeURIComponent(objectKey)}`
            : objectKey.startsWith("documents/private/")
              ? `/private/document?key=${encodeURIComponent(objectKey)}`
              : objectKey.startsWith("documents/public/") || objectKey.startsWith("artifacts/public/")
                ? `/private/bundle-source?key=${encodeURIComponent(objectKey)}`
                : `/private/object?key=${encodeURIComponent(objectKey)}`;
    const response = await this.request(query, {
      headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (response.status === 404) throw new AssetNotFoundError();
    if (!response.ok || !response.body) throw new Error(`Storage read failed (${response.status})`);
    return response.body;
  }

  async writeBundle(
    objectKey: string,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<GeneratedObjectMetadata> {
    if (this.options.publicOnly) throw new Error("Published storage is read-only");
    const response = await this.request(`/private/bundle?key=${encodeURIComponent(objectKey)}`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.context-use.knowledge-bundle" },
      body,
    });
    if (!response.ok) throw new Error(`Knowledge bundle storage write failed (${response.status})`);
    const result = await response.json() as { size_bytes?: unknown; content_hash?: unknown };
    if (!Number.isSafeInteger(result.size_bytes) || Number(result.size_bytes) <= 0
        || typeof result.content_hash !== "string" || !/^[a-f0-9]{64}$/.test(result.content_hash)) {
      throw new Error("Knowledge bundle storage returned invalid metadata");
    }
    return { sizeBytes: Number(result.size_bytes), contentHash: result.content_hash };
  }

  async inspectBundle(objectKey: string): Promise<GeneratedObjectMetadata | null> {
    const response = await this.request(`/private/bundle?key=${encodeURIComponent(objectKey)}`, { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Knowledge bundle storage inspection failed (${response.status})`);
    const sizeBytes = Number(response.headers.get("content-length"));
    const contentHash = response.headers.get("x-content-sha256") ?? "";
    return Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && /^[a-f0-9]{64}$/.test(contentHash)
      ? { sizeBytes, contentHash }
      : null;
  }

  async deleteBundle(objectKey: string): Promise<void> {
    const response = await this.request(`/private/bundle?key=${encodeURIComponent(objectKey)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Knowledge bundle storage deletion failed (${response.status})`);
  }

  async writeImportPart(input: {
    importId: string;
    partNumber: number;
    objectKey: string;
    sizeBytes: number;
    contentHash: string;
    body: ReadableStream<Uint8Array> | null;
  }): Promise<void> {
    const response = await this.request("/private/import-part", {
      method: "PUT",
      headers: {
        "content-length": String(input.sizeBytes),
        "x-import-id": input.importId,
        "x-part-number": String(input.partNumber),
        "x-object-key": input.objectKey,
        "x-content-sha256": input.contentHash,
      },
      body: input.body,
    });
    if (!response.ok) throw new Error(`Knowledge bundle part write failed (${response.status})`);
  }

  async deleteImportPart(objectKey: string): Promise<void> {
    const response = await this.request(`/private/import-part?key=${encodeURIComponent(objectKey)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`Knowledge bundle part deletion failed (${response.status})`);
  }

  async writeImportedObject(input: {
    importId: string;
    object: {
      object_key: string;
      size_bytes: number | string;
      content_hash: string;
      content_type: string;
    };
    body: ReadableStream<Uint8Array> | null;
  }): Promise<void> {
    const response = await this.request("/private/import-object", {
      method: "PUT",
      headers: {
        "content-length": String(input.object.size_bytes),
        "x-import-id": input.importId,
        "x-object-key": input.object.object_key,
        "x-content-type": input.object.content_type,
        "x-content-sha256": input.object.content_hash,
      },
      body: input.body,
    });
    if (!response.ok) throw new Error(`Imported knowledge object write failed (${response.status})`);
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

  async verify(objectKey: string, sizeBytes: number, contentHash: string): Promise<boolean> {
    if (this.options.publicOnly) return false;
    const response = await this.request("/private/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([JSON.stringify({ object_key: objectKey, size_bytes: sizeBytes, content_hash: contentHash })]).stream(),
    });
    if (!response.ok) return false;
    const result = await response.json() as { verified?: boolean };
    return result.verified === true;
  }
}
