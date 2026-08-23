import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { ActionDialog } from "./ActionDialog.tsx";
import { RunningRelease } from "./RunningRelease.tsx";
import { IntrinsicServices } from "./Services.tsx";

export type PasskeySummary = {
  id: string;
  name: string | null;
  created_at: string;
  device_type: string;
  backed_up: boolean;
};

type KnowledgeExportIntent = {
  intent: { id: string; expires_at: string };
  summary: {
    page_count: number;
    asset_count: number;
    total_bytes: number;
  };
  authentication_options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
};

type KnowledgeExportConfirmation = {
  download_url: string;
};

type KnowledgeExportStatus =
  | { status: "processing"; status_url: string }
  | { status: "ready"; download_url: string; filename: string; size_bytes: number }
  | { status: "failed"; message: string; code: string };

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

export type KnowledgeExportJob = {
  intentId: string;
  status: "processing" | "ready" | "failed";
  downloadUrl: string;
  filename?: string | undefined;
  sizeBytes?: number | undefined;
  error?: string | undefined;
};

const exportJobStorageKey = "context-use.knowledge-export-job";

export function storedExportJob(storage?: Pick<Storage, "getItem"> | null): KnowledgeExportJob | null {
  try {
    const source = storage === undefined
      ? typeof window === "undefined" ? null : window.localStorage
      : storage;
    if (!source) return null;
    const value = JSON.parse(source.getItem(exportJobStorageKey) ?? "null") as Partial<KnowledgeExportJob> | null;
    if (!value || typeof value.intentId !== "string" || !/^[a-f0-9-]{36}$/.test(value.intentId)) return null;
    if ((value as { reset?: unknown }).reset === true) return null;
    return {
      intentId: value.intentId,
      status: "processing",
      downloadUrl: `/api/dashboard/knowledge-exports/${encodeURIComponent(value.intentId)}/download`,
    };
  } catch {
    return null;
  }
}

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

function exportPreparationCopy(job: KnowledgeExportJob): { headline: string; detail: string } {
  const archive = `${job.filename ?? ""}${job.sizeBytes ? ` · ${formatExportBytes(job.sizeBytes)}` : ""}`;
  if (job.status === "failed") {
    return { headline: "Archive preparation stopped", detail: "" };
  }
  if (job.status === "processing") {
    return {
      headline: "Preparing latest snapshot…",
      detail: "The ZIP is being assembled and checked. You can leave Settings and return while this export remains available.",
    };
  }
  return { headline: "Archive ready to download", detail: archive };
}

export function KnowledgeExportPreparationStatus({
  job,
  onDownload,
  onReset,
}: {
  job: KnowledgeExportJob;
  onDownload: () => void;
  onReset: () => void;
}) {
  const { headline, detail } = exportPreparationCopy(job);
  return <div className={`export-preparation ${job.status}`} role="status" aria-live="polite">
    <div className="export-preparation-copy">
      {job.status === "processing" && <span className="export-spinner" aria-hidden="true" />}
      <div>
        <strong>{headline}</strong>
        {job.status === "failed"
          ? <small className="error">{job.error || "The archive could not be prepared."}</small>
          : detail && <small>{detail}</small>}
      </div>
    </div>
    {job.status === "ready" && <div className="export-preparation-actions">
      <a className="button primary" href={job.downloadUrl} onClick={onDownload}>Download archive</a>
      <button onClick={onReset}>Prepare another</button>
    </div>}
    {job.status === "failed" && <div className="export-preparation-actions">
      <button className="primary" onClick={onReset}>Start over</button>
    </div>}
  </div>;
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
  const [exportIntent, setExportIntent] = useState<KnowledgeExportIntent | null>(null);
  const [exportJob, setExportJob] = useState<KnowledgeExportJob | null>(storedExportJob);
  const [exportPreparing, setExportPreparing] = useState(false);
  const [exportWorking, setExportWorking] = useState(false);
  const [exportError, setExportError] = useState("");
  const [publicEntrypoint, setPublicEntrypoint] = useState<PublicEntrypoint | null>(null);
  const [publicEntrypointId, setPublicEntrypointId] = useState("");
  const [publicEntrypointWorking, setPublicEntrypointWorking] = useState(false);
  const [publicEntrypointError, setPublicEntrypointError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ entrypoint: PublicEntrypoint["entrypoint"] }>("/api/dashboard/pathless-publication-entrypoint"),
      api<{ candidates: PublicEntrypoint["candidates"] }>("/api/dashboard/pathless-publication-entrypoint/candidates"),
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

  const savePublicEntrypoint = async () => {
    setPublicEntrypointWorking(true);
    setPublicEntrypointError("");
    try {
      const result = await api<{ entrypoint: PublicEntrypoint["entrypoint"] }>("/api/dashboard/pathless-publication-entrypoint", {
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
    try {
      if (exportJob) {
        window.localStorage.setItem(exportJobStorageKey, JSON.stringify({
          intentId: exportJob.intentId,
        }));
      } else {
        window.localStorage.removeItem(exportJobStorageKey);
      }
    } catch {
      // The server-side intent remains resumable even when browser storage is unavailable.
    }
  }, [exportJob?.intentId]);

  useEffect(() => {
    if (!exportJob || exportJob.status !== "processing") return;
    const { intentId } = exportJob;
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const status = await api<KnowledgeExportStatus>(
          `/api/dashboard/knowledge-exports/${encodeURIComponent(intentId)}/status`,
        );
        if (!active) return;
        setExportJob((current) => {
          if (!current || current.intentId !== intentId) return current;
          if (status.status === "ready") {
            return {
              ...current,
              status: "ready",
              downloadUrl: status.download_url,
              filename: status.filename,
              sizeBytes: status.size_bytes,
              error: undefined,
            };
          }
          if (status.status === "failed") {
            return { ...current, status: "failed", error: status.message };
          }
          return current;
        });
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setExportJob((current) => current?.intentId === intentId ? null : current);
          setMessage(error.message);
          return;
        }
      }
      if (active) timeout = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [exportJob?.intentId, exportJob?.status]);

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

  const prepareExport = async () => {
    setExportPreparing(true);
    setExportError("");
    setMessage("");
    try {
      setExportIntent(await api<KnowledgeExportIntent>("/api/dashboard/knowledge-export-intents", {
        method: "POST",
        body: "{}",
      }));
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message
        : "Could not prepare the knowledge export");
    } finally {
      setExportPreparing(false);
    }
  };

  const cancelExportIntent = async () => {
    if (!exportIntent || exportWorking) return;
    const { id } = exportIntent.intent;
    setExportIntent(null);
    setExportError("");
    await api(`/api/dashboard/knowledge-export-intents/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    }).catch(() => undefined);
  };

  const downloadExport = async () => {
    if (!exportIntent) return;
    setExportWorking(true);
    setExportError("");
    try {
      const response = await startAuthentication({ optionsJSON: exportIntent.authentication_options });
      const confirmed = await api<KnowledgeExportConfirmation>("/api/dashboard/knowledge-exports/confirm", {
        method: "POST",
        body: JSON.stringify({ intent_id: exportIntent.intent.id, response }),
      });
      const intentId = exportIntent.intent.id;
      setExportIntent(null);
      setMessage("");
      setExportJob({
        intentId,
        status: "processing",
        downloadUrl: confirmed.download_url,
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Knowledge export failed");
    } finally {
      setExportWorking(false);
    }
  };
  return <main className="content-page settings-page"><header><div><span className="eyebrow">Owner-only controls</span><h1>Settings</h1></div><RunningRelease /></header>
    {message && <p>{message}</p>}
    <IntrinsicServices />
    <section><h2>Public entry point</h2>
      <p>Choose which already-published document opens at the public home page. Publishing and editing remain separate decisions; this pointer never publishes private content.</p>
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
    <section><h2>Export knowledge</h2>
      <p>Download the current active pages and assets as a readable, navigable Markdown vault. This portable snapshot is not an infrastructure backup and cannot be imported into Context Use.</p>
      {!exportJob && <button className="primary export-start-button" disabled={exportPreparing || exportWorking} onClick={() => void prepareExport()}>{exportPreparing ? "Checking assets…" : "Export with passkey"}</button>}
      {exportJob && <KnowledgeExportPreparationStatus
        job={exportJob}
        onDownload={() => {
          try { window.localStorage.removeItem(exportJobStorageKey); } catch { /* Browser storage may be unavailable. */ }
          setMessage("Archive download started.");
        }}
        onReset={() => setExportJob(null)}
      />}
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
    {exportIntent && <ActionDialog
      eyebrow="Private knowledge export"
      title="Download your knowledge snapshot?"
      description="The ZIP contains the current private and public knowledge as a readable Markdown vault. It is unencrypted and requires a fresh owner-passkey verification."
      confirmLabel="Verify passkey and download"
      workingLabel="Waiting for passkey…"
      working={exportWorking}
      error={exportError}
      onCancel={() => void cancelExportIntent()}
      onConfirm={() => void downloadExport()}
    >
      <dl className="action-dialog-details">
        <div><dt>Current pages</dt><dd>about {exportIntent.summary.page_count}</dd></div>
        <div><dt>Active assets</dt><dd>about {exportIntent.summary.asset_count}</dd></div>
        <div><dt>Size</dt><dd>about {formatExportBytes(exportIntent.summary.total_bytes)}</dd></div>
      </dl>
    </ActionDialog>}
  </main>;
}
