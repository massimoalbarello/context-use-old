import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState, type ReactNode } from "react";
import { api, uploadKnowledgeBundlePart } from "../api.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { McpClients } from "./McpClients.tsx";
import { RunningRelease } from "./RunningRelease.tsx";
import { IntrinsicServices } from "./Services.tsx";
import type { PasskeySummary } from "../types.ts";

export type { PasskeySummary } from "../types.ts";

type KnowledgeBundleExportConfirmation = {
  download_url: string;
};

type FullBundleIntent = {
  intent: { id: string; expires_at: string };
  summary: { page_count: number; asset_count: number; estimated_bytes: number };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  status_url: string;
};

type FullBundleStatus = {
  status: "pending" | "snapshotting" | "processing" | "ready" | "failed";
  phase: string;
  records_completed: number;
  records_total: number;
  blobs_completed: number;
  blobs_total: number;
  bytes_completed: number;
  bytes_total: number;
  download_url?: string;
  filename?: string;
  size_bytes?: number;
  message?: string;
};

type KnowledgeImportStatus = {
  import_id: string;
  status: "uploading" | "validating" | "awaiting_confirmation" | "restoring" | "complete" | "failed";
  phase: string;
  parts_completed: number;
  total_parts: number;
  uploaded_parts: number[];
  records_completed: number;
  records_total: number;
  blobs_completed: number;
  blobs_total: number;
  bytes_completed: number;
  bytes_total: number;
  authentication_options?: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  message?: string;
};

type KnowledgeImportJob = KnowledgeImportStatus & { part_size: number; filename: string };

type PublicEntrypointCandidate = {
  public_id: string;
  public_title: string;
  public_summary: string;
  public_last_edited_at: string;
};

type PublicEntrypoint = {
  entrypoint: {
    public_id: string | null;
    configured: boolean;
    active: boolean;
  };
  candidates: PublicEntrypointCandidate[];
};

export function publicEntrypointOptionLabel(page: PublicEntrypointCandidate): string {
  return `${page.public_title} — ${page.public_summary}`;
}

const bundleJobStorageKey = "context-use.knowledge-bundle-job";
const importJobStorageKey = "context-use.knowledge-import-job";

type EnrollmentIntent = {
  intent: {
    id: string;
    name: string;
    authenticator_attachment: "cross-platform" | null;
    expires_at: string;
  };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
};

type EnrollmentAuthorization = {
  enrollment_claim: string;
  setup_url: string;
  expires_at: string;
  name: string;
  authenticator_attachment: "cross-platform" | null;
};

type RemovalIntent = {
  intent: {
    id: string;
    passkey_id: string;
    passkey_name: string | null;
    expires_at: string;
  };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
};

export function formatExportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const percentage = value === null ? null : Math.max(0, Math.min(100, value * 100));
  return <div className="archive-upload" role="status" aria-live="polite">
    <div className="archive-upload-copy"><strong>{label}</strong>
      <small>{percentage === null ? "Working…" : `${percentage.toFixed(1)}%`}</small>
    </div>
    <progress max={100} value={percentage ?? undefined} aria-label={label} />
  </div>;
}

export function FullImportAvailability({
  available,
  error,
  children,
}: {
  available: boolean | null;
  error?: string;
  children?: ReactNode;
}) {
  if (error) return <p className="error" role="alert">{error}</p>;
  if (available === null) return <p role="status">Checking whether this instance can import a bundle…</p>;
  if (!available) {
    return <p>This instance already contains personal knowledge, assets, publication state, or customized settings. Full bundle import is only available during initialization.</p>;
  }
  return <>{children}</>;
}

export function Settings({
  passkeys,
  onPasskeysChanged,
}: {
  passkeys: PasskeySummary[];
  onPasskeysChanged: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [addMode, setAddMode] = useState<"hardware" | "device">("hardware");
  const [enrollmentIntent, setEnrollmentIntent] = useState<EnrollmentIntent | null>(null);
  const [enrollmentLink, setEnrollmentLink] = useState("");
  const [enrollmentPreparing, setEnrollmentPreparing] = useState(false);
  const [enrollmentWorking, setEnrollmentWorking] = useState(false);
  const [enrollmentError, setEnrollmentError] = useState("");
  const [removalIntent, setRemovalIntent] = useState<RemovalIntent | null>(null);
  const [removalPreparingId, setRemovalPreparingId] = useState("");
  const [removalWorking, setRemovalWorking] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const [bundleIntent, setBundleIntent] = useState<FullBundleIntent | null>(null);
  const [bundleJobId, setBundleJobId] = useState<string | null>(() => {
    try {
      if (typeof window === "undefined") return null;
      const value = window.localStorage.getItem(bundleJobStorageKey);
      return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
    } catch {
      return null;
    }
  });
  const [bundleStatus, setBundleStatus] = useState<FullBundleStatus | null>(null);
  const [bundleWorking, setBundleWorking] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importJob, setImportJob] = useState<KnowledgeImportJob | null>(() => {
    try {
      if (typeof window === "undefined") return null;
      const saved = JSON.parse(window.localStorage.getItem(importJobStorageKey) ?? "null") as {
        import_id?: unknown; filename?: unknown; size_bytes?: unknown; part_size?: unknown; total_parts?: unknown;
      } | null;
      if (!saved || typeof saved.import_id !== "string" || !/^[a-f0-9-]{36}$/.test(saved.import_id)
          || typeof saved.filename !== "string" || !Number.isSafeInteger(saved.size_bytes)
          || !Number.isSafeInteger(saved.part_size) || !Number.isSafeInteger(saved.total_parts)) return null;
      return {
        import_id: saved.import_id,
        filename: saved.filename,
        part_size: Number(saved.part_size),
        status: "uploading",
        phase: "upload",
        parts_completed: 0,
        total_parts: Number(saved.total_parts),
        uploaded_parts: [],
        records_completed: 0,
        records_total: 0,
        blobs_completed: 0,
        blobs_total: 0,
        bytes_completed: 0,
        bytes_total: Number(saved.size_bytes),
      };
    } catch {
      return null;
    }
  });
  const [importWorking, setImportWorking] = useState(false);
  const [importError, setImportError] = useState("");
  const [importAvailable, setImportAvailable] = useState<boolean | null>(null);
  const [importAvailabilityError, setImportAvailabilityError] = useState("");
  const [publicEntrypoint, setPublicEntrypoint] = useState<PublicEntrypoint | null>(null);
  const [publicEntrypointId, setPublicEntrypointId] = useState("");
  const [publicEntrypointWorking, setPublicEntrypointWorking] = useState(false);
  const [publicEntrypointError, setPublicEntrypointError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ entrypoint: PublicEntrypoint["entrypoint"] }>("/api/dashboard/publication-entrypoint"),
      api<{ candidates: PublicEntrypoint["candidates"] }>("/api/dashboard/publication-entrypoint/candidates"),
    ])
      .then(([entrypoint, candidates]) => {
        if (!active) return;
        setPublicEntrypoint({ ...entrypoint, ...candidates });
        setPublicEntrypointId(entrypoint.entrypoint.public_id ?? "");
      })
      .catch((error: unknown) => {
        if (active) setPublicEntrypointError(error instanceof Error ? error.message : "Public entry point could not be loaded");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    api<{ available: boolean }>("/api/dashboard/knowledge-imports/availability")
      .then(({ available }) => {
        if (active) setImportAvailable(available);
      })
      .catch((error: unknown) => {
        if (active) setImportAvailabilityError(error instanceof Error
          ? error.message
          : "Import availability could not be checked");
      });
    return () => { active = false; };
  }, []);

  const savePublicEntrypoint = async () => {
    setPublicEntrypointWorking(true);
    setPublicEntrypointError("");
    try {
      const result = await api<{ entrypoint: PublicEntrypoint["entrypoint"] }>("/api/dashboard/publication-entrypoint", {
        method: "PUT",
        body: JSON.stringify({ public_id: publicEntrypointId || null }),
      });
      setPublicEntrypoint((current) => current ? { ...current, entrypoint: result.entrypoint } : current);
      setMessage(publicEntrypointId ? "Public entry point updated." : "Public entry point removed.");
    } catch (error) {
      setPublicEntrypointError(error instanceof Error ? error.message : "Public entry point could not be updated");
    } finally {
      setPublicEntrypointWorking(false);
    }
  };

  useEffect(() => {
    const intentId = bundleJobId;
    if (!intentId || bundleStatus?.status === "ready" || bundleStatus?.status === "failed") return;
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const status = await api<FullBundleStatus>(
          `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/status`,
        );
        if (!active) return;
        setBundleStatus(status);
        if (!["ready", "failed"].includes(status.status)) {
          timeout = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (error) {
        if (active) setBundleError(error instanceof Error ? error.message : "Bundle status could not be loaded");
      }
    };
    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [bundleJobId, bundleStatus?.status]);

  useEffect(() => {
    try {
      if (bundleJobId) window.localStorage.setItem(bundleJobStorageKey, bundleJobId);
      else window.localStorage.removeItem(bundleJobStorageKey);
    } catch {
      // The server-side job remains available until its expiry.
    }
  }, [bundleJobId]);

  useEffect(() => {
    const importId = importJob?.import_id;
    if (!importId || !["uploading", "validating", "restoring"].includes(importJob.status)) return;
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const status = await api<KnowledgeImportStatus>(
          `/api/dashboard/knowledge-imports/${encodeURIComponent(importId)}/status`,
        );
        if (!active) return;
        setImportJob((current) => current?.import_id === importId ? { ...current, ...status } : current);
        if (["uploading", "validating", "restoring"].includes(status.status)) {
          timeout = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (error) {
        if (active) setImportError(error instanceof Error ? error.message : "Import status could not be loaded");
      }
    };
    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [importJob?.import_id, importJob?.status]);

  useEffect(() => {
    try {
      if (importJob && importJob.status !== "complete") {
        window.localStorage.setItem(importJobStorageKey, JSON.stringify({
          import_id: importJob.import_id,
          filename: importJob.filename,
          size_bytes: importJob.bytes_total,
          part_size: importJob.part_size,
          total_parts: importJob.total_parts,
        }));
      } else {
        window.localStorage.removeItem(importJobStorageKey);
      }
    } catch {
      // The upload remains resumable on the server when browser storage is unavailable.
    }
  }, [importJob?.import_id, importJob?.status]);

  const prepareEnrollment = async () => {
    const name = passkeyName.trim();
    if (!name) {
      setEnrollmentError("Give this passkey a name first.");
      return;
    }
    setEnrollmentPreparing(true);
    setEnrollmentError("");
    setEnrollmentLink("");
    setMessage("");
    try {
      setEnrollmentIntent(await api<EnrollmentIntent>("/api/dashboard/passkey-enrollment-intents", {
        method: "POST",
        body: JSON.stringify({
          name,
          authenticator_attachment: addMode === "hardware" ? "cross-platform" : null,
        }),
      }));
    } catch (error) {
      setEnrollmentError(error instanceof Error ? error.message : "Could not prepare passkey enrollment");
    } finally {
      setEnrollmentPreparing(false);
    }
  };

  const authorizeEnrollment = async () => {
    if (!enrollmentIntent) return;
    setEnrollmentWorking(true);
    setEnrollmentError("");
    try {
      const response = await startAuthentication({ optionsJSON: enrollmentIntent.authentication_options });
      const authorization = await api<EnrollmentAuthorization>(
        `/api/dashboard/passkey-enrollment-intents/${encodeURIComponent(enrollmentIntent.intent.id)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ response }),
        },
      );
      setEnrollmentIntent(null);
      if (authorization.authenticator_attachment === "cross-platform") {
        const { authClient } = await import("../auth-client.ts");
        const result = await authClient.passkey.addPasskey({
          name: authorization.name,
          authenticatorAttachment: "cross-platform",
          context: JSON.stringify({ enrollment_claim: authorization.enrollment_claim }),
        });
        if (result.error) throw new Error(result.error.message ?? "Hardware passkey setup failed");
        setPasskeyName("");
        setMessage(`${authorization.name} was added.`);
        await onPasskeysChanged();
      } else {
        setEnrollmentLink(authorization.setup_url);
        setMessage("Passkey enrollment authorized. Open the one-time link on the other device.");
      }
    } catch (error) {
      setEnrollmentError(error instanceof Error ? error.message : "Passkey enrollment failed");
    } finally {
      setEnrollmentWorking(false);
    }
  };

  const copyEnrollmentLink = async () => {
    try {
      await navigator.clipboard.writeText(enrollmentLink);
      setMessage("One-time passkey setup link copied.");
    } catch {
      setMessage("Could not copy automatically. Select and copy the link below.");
    }
  };

  const prepareRemoval = async (passkey: PasskeySummary) => {
    setRemovalPreparingId(passkey.id);
    setRemovalError("");
    setMessage("");
    try {
      setRemovalIntent(await api<RemovalIntent>(
        `/api/dashboard/passkeys/${encodeURIComponent(passkey.id)}/removal-intents`,
        { method: "POST", body: "{}" },
      ));
    } catch (error) {
      setRemovalError(error instanceof Error ? error.message : "Could not prepare passkey removal");
    } finally {
      setRemovalPreparingId("");
    }
  };

  const removePasskey = async () => {
    if (!removalIntent) return;
    setRemovalWorking(true);
    setRemovalError("");
    try {
      const response = await startAuthentication({ optionsJSON: removalIntent.authentication_options });
      await api(
        `/api/dashboard/passkeys/${encodeURIComponent(removalIntent.intent.passkey_id)}/remove`,
        {
          method: "POST",
          body: JSON.stringify({ intent_id: removalIntent.intent.id, response }),
        },
      );
      window.location.assign("/app");
    } catch (error) {
      setRemovalError(error instanceof Error ? error.message : "Passkey removal failed");
      setRemovalWorking(false);
    }
  };

  const prepareFullBundle = async () => {
    setBundleWorking(true);
    setBundleError("");
    try {
      setBundleIntent(await api<FullBundleIntent>("/api/dashboard/knowledge-bundle-export-intents", {
        method: "POST",
        body: "{}",
      }));
      setBundleStatus(null);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Could not prepare the full knowledge bundle");
    } finally {
      setBundleWorking(false);
    }
  };

  const authorizeFullBundle = async () => {
    if (!bundleIntent) return;
    setBundleWorking(true);
    setBundleError("");
    try {
      const response = await startAuthentication({ optionsJSON: bundleIntent.authentication_options });
      await api<KnowledgeBundleExportConfirmation>("/api/dashboard/knowledge-bundle-exports/confirm", {
        method: "POST",
        body: JSON.stringify({ intent_id: bundleIntent.intent.id, response }),
      });
      setBundleStatus({
        status: "pending",
        phase: "snapshot",
        records_completed: 0,
        records_total: 0,
        blobs_completed: 0,
        blobs_total: 0,
        bytes_completed: 0,
        bytes_total: bundleIntent.summary.estimated_bytes,
      });
      setBundleJobId(bundleIntent.intent.id);
      setBundleIntent(null);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "Full knowledge export failed");
    } finally {
      setBundleWorking(false);
    }
  };

  const uploadFullBundle = async () => {
    if (!importFile) return;
    setImportWorking(true);
    setImportError("");
    try {
      let job: KnowledgeImportJob;
      if (importJob?.status === "uploading") {
        if (importJob.filename !== importFile.name || importJob.bytes_total !== importFile.size) {
          throw new Error(`Choose the original ${importJob.filename} file (${formatExportBytes(importJob.bytes_total)}) to resume this upload.`);
        }
        const status = await api<KnowledgeImportStatus>(
          `/api/dashboard/knowledge-imports/${encodeURIComponent(importJob.import_id)}/status`,
        );
        if (status.status !== "uploading") throw new Error("This upload is no longer accepting parts.");
        job = { ...importJob, ...status };
      } else {
        const created = await api<{
          import_id: string;
          part_size: number;
          total_parts: number;
          uploaded_parts: number[];
        }>("/api/dashboard/knowledge-imports", {
          method: "POST",
          body: JSON.stringify({ filename: importFile.name, size_bytes: importFile.size }),
        });
        job = {
          import_id: created.import_id,
          filename: importFile.name,
          part_size: created.part_size,
          status: "uploading",
          phase: "upload",
          parts_completed: 0,
          total_parts: created.total_parts,
          uploaded_parts: [],
          records_completed: 0,
          records_total: 0,
          blobs_completed: 0,
          blobs_total: 0,
          bytes_completed: 0,
          bytes_total: importFile.size,
        };
      }
      setImportJob(job);
      const uploaded = new Set(job.uploaded_parts);
      for (let partNumber = 0; partNumber < job.total_parts; partNumber += 1) {
        if (uploaded.has(partNumber)) continue;
        const start = partNumber * job.part_size;
        const part = importFile.slice(start, Math.min(importFile.size, start + job.part_size));
        await uploadKnowledgeBundlePart(job.import_id, partNumber, part, await sha256(part));
        uploaded.add(partNumber);
        job = {
          ...job,
          parts_completed: uploaded.size,
          uploaded_parts: [...uploaded].sort((left, right) => left - right),
          bytes_completed: [...uploaded].reduce((total, number) => (
            total + Math.min(job.part_size, importFile.size - number * job.part_size)
          ), 0),
        };
        setImportJob(job);
      }
      await api(`/api/dashboard/knowledge-imports/${encodeURIComponent(job.import_id)}/validate`, {
        method: "POST",
        body: "{}",
      });
      setImportJob({ ...job, status: "validating", phase: "manifest", bytes_completed: 0 });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Knowledge bundle upload failed");
    } finally {
      setImportWorking(false);
    }
  };

  const authorizeImport = async () => {
    if (!importJob?.authentication_options) return;
    setImportWorking(true);
    setImportError("");
    try {
      const response = await startAuthentication({ optionsJSON: importJob.authentication_options });
      await api("/api/dashboard/knowledge-imports/confirm", {
        method: "POST",
        body: JSON.stringify({ intent_id: importJob.import_id, response }),
      });
      setImportJob({ ...importJob, status: "restoring", phase: "objects", bytes_completed: 0,
        blobs_completed: 0, records_completed: 0 });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Knowledge import authorization failed");
    } finally {
      setImportWorking(false);
    }
  };

  const bundleProgress = bundleStatus
    ? bundleStatus.bytes_total > 0
      ? bundleStatus.bytes_completed / bundleStatus.bytes_total
      : null
    : null;
  const importProgress = importJob
    ? importJob.status === "uploading"
      ? importJob.bytes_total > 0 ? importJob.bytes_completed / importJob.bytes_total : null
      : importJob.blobs_total > 0
        ? importJob.blobs_completed / importJob.blobs_total
        : null
    : null;
  return <main className="content-page settings-page"><header><div><span className="eyebrow">Owner-only controls</span><h1>Settings</h1></div><RunningRelease /></header>
    {message && <p>{message}</p>}
    <IntrinsicServices />
    <section><h2>Public entry point</h2>
      <p>Choose which already-published page opens at the public home page. Publishing and editing remain separate decisions; this pointer never publishes private content.</p>
      {publicEntrypointError && <p className="error" role="alert">{publicEntrypointError}</p>}
      {publicEntrypoint && <div className="public-entrypoint-setting">
        <label>Entry page<select value={publicEntrypointId} onChange={(event) => setPublicEntrypointId(event.target.value)}>
          <option value="">No public entry point</option>
          {publicEntrypoint.entrypoint.public_id
            && !publicEntrypoint.candidates.some((page) => page.public_id === publicEntrypoint.entrypoint.public_id)
            && <option value={publicEntrypoint.entrypoint.public_id}>Previously selected page · currently private</option>}
          {publicEntrypoint.candidates.map((page) => <option value={page.public_id} key={page.public_id}>{publicEntrypointOptionLabel(page)}</option>)}
        </select></label>
        <button className="primary" disabled={publicEntrypointWorking || publicEntrypointId === (publicEntrypoint.entrypoint.public_id ?? "")} onClick={() => void savePublicEntrypoint()}>{publicEntrypointWorking ? "Saving…" : "Save entry point"}</button>
      </div>}
    </section>
    <McpClients />
    <section><h2>Passkeys</h2><p>Passkeys sign in as the installation owner and can confirm sensitive actions. Adding or removing one requires fresh verification with an existing passkey, and at least one must always remain.</p>
      <div className="security-list">{passkeys.map((key) => <article key={key.id}><div><strong>{key.name || "Unnamed passkey"}</strong><span>Added {new Date(key.created_at).toLocaleString()} · {key.device_type === "singleDevice" ? "Device-bound passkey" : "Multi-device passkey"}{key.backed_up ? " · Backed up" : ""}</span></div><button className="danger" disabled={passkeys.length <= 1 || Boolean(removalPreparingId)} onClick={() => void prepareRemoval(key)}>{removalPreparingId === key.id ? "Preparing…" : "Remove"}</button></article>)}</div>
      {removalError && !removalIntent && <p className="error">{removalError}</p>}
      <div className="passkey-add">
        <label>Passkey name<input maxLength={80} placeholder="e.g. YubiKey 5C or Work laptop" value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} /></label>
        <div className="passkey-kind" role="group" aria-label="Passkey type">
          <label><input type="radio" name="passkey-kind" checked={addMode === "hardware"} onChange={() => setAddMode("hardware")} /><span><strong>Hardware security key</strong><small>Requests a USB, NFC, or other cross-platform authenticator instead of Touch ID.</small></span></label>
          <label><input type="radio" name="passkey-kind" checked={addMode === "device"} onChange={() => setAddMode("device")} /><span><strong>Another device</strong><small>Creates a five-minute, one-time setup link to open on that device.</small></span></label>
        </div>
        {enrollmentError && !enrollmentIntent && <p className="error">{enrollmentError}</p>}
        <button className="primary" disabled={enrollmentPreparing || enrollmentWorking} onClick={() => void prepareEnrollment()}>{enrollmentPreparing ? "Preparing…" : "Add passkey"}</button>
        {enrollmentLink && <div className="passkey-link"><strong>One-time setup link</strong><p>Open this on the device you are adding. It expires five minutes after authorization.</p><div><input readOnly value={enrollmentLink} onFocus={(event) => event.currentTarget.select()} /><button onClick={() => void copyEnrollmentLink()}>Copy</button></div></div>}
      </div>
    </section>
    <section><h2>Full backup and migration</h2>
      <p>Export every page, retained revision, source record, asset, internal link, and publication record in a versioned Context Use bundle. Original UUIDs are retained, so <code>context-use://object/&lt;uuid&gt;</code> links remain valid after import.</p>
      <p>The bundle is an unencrypted logical backup, independent of the current SQL schema. Keep it somewhere private.</p>
      {bundleError && <p className="error" role="alert">{bundleError}</p>}
      {!bundleStatus && !bundleIntent && <button className="primary export-start-button" disabled={bundleWorking} onClick={() => void prepareFullBundle()}>{bundleWorking ? "Preparing…" : "Export full bundle with passkey"}</button>}
      {bundleStatus && !["ready", "failed"].includes(bundleStatus.status)
        && <ProgressBar value={bundleProgress} label={bundleStatus.phase === "records" ? "Writing records" : bundleStatus.phase === "objects" ? "Streaming assets and content" : "Capturing a consistent snapshot"} />}
      {bundleStatus?.status === "ready" && <div className="archive-upload">
        <div className="archive-upload-copy"><strong>Full bundle ready</strong><small>{bundleStatus.filename} · {formatExportBytes(bundleStatus.size_bytes ?? 0)}</small></div>
        <a className="button primary" href={bundleStatus.download_url}>Download full bundle</a>
        <button onClick={() => { setBundleStatus(null); setBundleJobId(null); }}>Prepare another</button>
      </div>}
      {bundleStatus?.status === "failed" && <div><p className="error" role="alert">{bundleStatus.message || "The full bundle could not be prepared."}</p><button onClick={() => { setBundleStatus(null); setBundleJobId(null); }}>Start over</button></div>}
    </section>
    <section><h2>Import full bundle</h2>
      <p>Restore a full bundle onto a fresh Context Use instance. Local account credentials, passkeys, and service secrets remain those of this destination instance.</p>
      <p><strong>Initialization only:</strong> import may replace the untouched default knowledge template. The first personal knowledge, asset, publication, automation, or settings change permanently closes this import window.</p>
      <FullImportAvailability available={importAvailable} error={importAvailabilityError}>
        <div className="archive-import">
        {(!importJob || importJob.status === "uploading") && <div className="archive-import-field">
          <span className="archive-import-label">Context Use bundle</span>
          <label className={`archive-picker${importFile ? " has-file" : ""}${importWorking ? " is-disabled" : ""}`}>
            <input className="archive-picker-input" type="file" accept=".cuse,application/vnd.context-use.knowledge-bundle" disabled={importWorking} onChange={(event) => { setImportFile(event.currentTarget.files?.[0] ?? null); setImportError(""); }} />
            <span className="archive-picker-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.75h7l3 3v13.5H7z" /><path d="M14 3.75v3h3M10 9.25h4m-4 3h4m-4 3h4" /></svg></span>
            <span className="archive-picker-copy"><strong>{importFile ? importFile.name : "Choose a full bundle"}</strong><small>{importFile ? formatExportBytes(importFile.size) : "Select the original .cuse file"}</small></span>
            <span className="archive-picker-action">{importFile ? "Replace" : "Browse files"}</span>
          </label>
          {importJob?.status === "uploading" && <small className="archive-upload-note">This upload is resumable. Re-select the same file after a reload or network interruption; completed parts are skipped.</small>}
          <button className="primary" disabled={!importFile || importWorking} onClick={() => void uploadFullBundle()}>{importWorking ? "Uploading…" : importJob?.status === "uploading" ? "Resume upload" : "Upload and validate"}</button>
        </div>}
        {importJob && !["awaiting_confirmation", "complete", "failed"].includes(importJob.status)
          && <ProgressBar value={importProgress} label={importJob.status === "uploading" ? "Uploading bundle" : importJob.status === "validating" ? "Validating every record and blob" : importJob.phase === "database" ? "Restoring database relationships" : "Restoring assets and content"} />}
        {importJob?.status === "awaiting_confirmation" && <div className="archive-upload"><div className="archive-upload-copy"><strong>Bundle verified</strong><small>Every frame passed structural and integrity validation. Owner authorization is required before restoring it.</small></div><button className="primary" disabled={importWorking} onClick={() => void authorizeImport()}>{importWorking ? "Waiting for passkey…" : "Import with passkey"}</button></div>}
        {importJob?.status === "complete" && <div className="archive-upload"><div className="archive-upload-copy"><strong>Knowledge import complete</strong><small>Original UUIDs, links, history, assets, and publication records were restored.</small></div></div>}
        {importJob?.status === "failed" && <div><p className="error" role="alert">{importJob.message || "The knowledge bundle could not be imported."}</p><button onClick={() => { setImportJob(null); setImportFile(null); }}>Choose another bundle</button></div>}
        {importError && <p className="error" role="alert">{importError}</p>}
        </div>
      </FullImportAvailability>
    </section>
    {enrollmentIntent && <ActionDialog
      eyebrow="Passkey enrollment"
      title={`Authorize ${enrollmentIntent.intent.name}?`}
      description={enrollmentIntent.intent.authenticator_attachment === "cross-platform"
        ? "First verify an existing passkey. Your browser will then ask for the new hardware security key; Touch ID is not requested for that registration."
        : "Verify an existing passkey to create a five-minute, single-use setup link for the other device."}
      confirmLabel="Verify and continue"
      workingLabel="Waiting for passkey…"
      working={enrollmentWorking}
      error={enrollmentError}
      onCancel={() => { setEnrollmentError(""); setEnrollmentIntent(null); }}
      onConfirm={() => void authorizeEnrollment()}
    />}
    {removalIntent && <ActionDialog
      eyebrow="Remove passkey"
      title={`Remove ${removalIntent.intent.passkey_name || "this passkey"}?`}
      description="A fresh passkey verification is required. Removing it revokes every dashboard session, including this one, and you will need to sign in again with a remaining passkey."
      confirmLabel="Verify and remove"
      workingLabel="Waiting for passkey…"
      working={removalWorking}
      error={removalError}
      onCancel={() => { setRemovalError(""); setRemovalIntent(null); }}
      onConfirm={() => void removePasskey()}
    />}
    {bundleIntent && !bundleStatus && <ActionDialog
      eyebrow="Full knowledge backup"
      title="Export the complete knowledge base?"
      description="This unencrypted logical bundle contains every retained record and immutable content blob with its original UUID. A fresh owner-passkey verification is required."
      confirmLabel="Verify and build bundle"
      workingLabel="Waiting for passkey…"
      working={bundleWorking}
      error={bundleError}
      onCancel={() => { setBundleIntent(null); setBundleError(""); }}
      onConfirm={() => void authorizeFullBundle()}
    >
      <dl className="action-dialog-details">
        <div><dt>Current pages</dt><dd>about {bundleIntent.summary.page_count}</dd></div>
        <div><dt>Active assets</dt><dd>about {bundleIntent.summary.asset_count}</dd></div>
        <div><dt>Content bytes</dt><dd>at least {formatExportBytes(bundleIntent.summary.estimated_bytes)}</dd></div>
      </dl>
    </ActionDialog>}
  </main>;
}
