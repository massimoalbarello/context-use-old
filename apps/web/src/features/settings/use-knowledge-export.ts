import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { api } from "../../api.ts";

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

const bundleJobStorageKey = "context-use.knowledge-bundle-job";

function restoredBundleJobId(): string | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const value = window.localStorage.getItem(bundleJobStorageKey);
    return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function useKnowledgeExport() {
  const [intent, setIntent] = useState<FullBundleIntent | null>(null);
  const [jobId, setJobId] = useState<string | null>(restoredBundleJobId);
  const [status, setStatus] = useState<FullBundleStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const intentId = jobId;
    if (!intentId || status?.status === "ready" || status?.status === "failed") {
      return;
    }
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const nextStatus = await api<FullBundleStatus>(
          `/api/dashboard/knowledge-bundles/${encodeURIComponent(intentId)}/status`,
        );
        if (!active) {
          return;
        }
        setStatus(nextStatus);
        if (!["ready", "failed"].includes(nextStatus.status)) {
          timeout = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Bundle status could not be loaded");
        }
      }
    };
    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    };
  }, [jobId, status?.status]);

  useEffect(() => {
    try {
      if (jobId) {
        window.localStorage.setItem(bundleJobStorageKey, jobId);
      } else {
        window.localStorage.removeItem(bundleJobStorageKey);
      }
    } catch {
      // The server-side job remains available until its expiry.
    }
  }, [jobId]);

  const prepare = async () => {
    setWorking(true);
    setError("");
    try {
      setIntent(
        await api<FullBundleIntent>("/api/dashboard/knowledge-bundle-export-intents", {
          method: "POST",
          body: "{}",
        }),
      );
      setStatus(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not prepare the full knowledge bundle",
      );
    } finally {
      setWorking(false);
    }
  };

  const authorize = async () => {
    if (!intent) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      const response = await startAuthentication({ optionsJSON: intent.authentication_options });
      await api<KnowledgeBundleExportConfirmation>(
        "/api/dashboard/knowledge-bundle-exports/confirm",
        { method: "POST", body: JSON.stringify({ intent_id: intent.intent.id, response }) },
      );
      setStatus({
        status: "pending",
        phase: "snapshot",
        records_completed: 0,
        records_total: 0,
        blobs_completed: 0,
        blobs_total: 0,
        bytes_completed: 0,
        bytes_total: intent.summary.estimated_bytes,
      });
      setJobId(intent.intent.id);
      setIntent(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Full knowledge export failed");
    } finally {
      setWorking(false);
    }
  };

  return {
    authorize,
    cancel: () => {
      setIntent(null);
      setError("");
    },
    error,
    intent,
    prepare,
    reset: () => {
      setStatus(null);
      setJobId(null);
    },
    status,
    working,
  };
}

export type KnowledgeExportModel = ReturnType<typeof useKnowledgeExport>;
