import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { api, uploadKnowledgeBundlePart } from "../../api.ts";
import { formatExportBytes, sha256 } from "./settings-format.ts";

type KnowledgeImportStatus = {
  import_id: string;
  status:
    | "uploading"
    | "validating"
    | "awaiting_confirmation"
    | "restoring"
    | "complete"
    | "failed";
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

const importJobStorageKey = "context-use.knowledge-import-job";
const activeImportStatuses = ["uploading", "validating", "restoring"];

function restoredImportJob(): KnowledgeImportJob | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const saved = JSON.parse(window.localStorage.getItem(importJobStorageKey) ?? "null") as {
      import_id?: unknown;
      filename?: unknown;
      size_bytes?: unknown;
      part_size?: unknown;
      total_parts?: unknown;
    } | null;
    if (
      !saved ||
      typeof saved.import_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(saved.import_id) ||
      typeof saved.filename !== "string" ||
      !Number.isSafeInteger(saved.size_bytes) ||
      !Number.isSafeInteger(saved.part_size) ||
      !Number.isSafeInteger(saved.total_parts)
    ) {
      return null;
    }
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
}

function summarizeUploadedParts({
  fileSize,
  job,
  uploaded,
}: {
  fileSize: number;
  job: KnowledgeImportJob;
  uploaded: Set<number>;
}) {
  const uploadedParts: number[] = [];
  let bytesCompleted = 0;
  for (let partNumber = 0; partNumber < job.total_parts; partNumber += 1) {
    if (!uploaded.has(partNumber)) {
      continue;
    }
    uploadedParts.push(partNumber);
    bytesCompleted += Math.min(job.part_size, fileSize - partNumber * job.part_size);
  }
  return { bytesCompleted, uploadedParts };
}

export function useKnowledgeImport() {
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<KnowledgeImportJob | null>(restoredImportJob);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityError, setAvailabilityError] = useState("");

  useEffect(() => {
    let active = true;
    api<{ available: boolean }>("/api/dashboard/knowledge-imports/availability")
      .then((result) => {
        if (active) {
          setAvailable(result.available);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setAvailabilityError(
            caught instanceof Error ? caught.message : "Import availability could not be checked",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const importId = job?.import_id;
    if (!importId || !activeImportStatuses.includes(job.status)) {
      return;
    }
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const status = await api<KnowledgeImportStatus>(
          `/api/dashboard/knowledge-imports/${encodeURIComponent(importId)}/status`,
        );
        if (!active) {
          return;
        }
        setJob((current) =>
          current?.import_id === importId ? { ...current, ...status } : current,
        );
        if (activeImportStatuses.includes(status.status)) {
          timeout = window.setTimeout(() => void poll(), 1_500);
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Import status could not be loaded");
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
  }, [job?.import_id, job?.status]);

  useEffect(() => {
    try {
      if (job && job.status !== "complete") {
        window.localStorage.setItem(
          importJobStorageKey,
          JSON.stringify({
            import_id: job.import_id,
            filename: job.filename,
            size_bytes: job.bytes_total,
            part_size: job.part_size,
            total_parts: job.total_parts,
          }),
        );
      } else {
        window.localStorage.removeItem(importJobStorageKey);
      }
    } catch {
      // The upload remains resumable on the server when browser storage is unavailable.
    }
  }, [job]);

  const upload = async () => {
    if (!file) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      let nextJob: KnowledgeImportJob;
      if (job?.status === "uploading") {
        if (job.filename !== file.name || job.bytes_total !== file.size) {
          throw new Error(
            `Choose the original ${job.filename} file (${formatExportBytes(job.bytes_total)}) to resume this upload.`,
          );
        }
        const status = await api<KnowledgeImportStatus>(
          `/api/dashboard/knowledge-imports/${encodeURIComponent(job.import_id)}/status`,
        );
        if (status.status !== "uploading") {
          throw new Error("This upload is no longer accepting parts.");
        }
        nextJob = { ...job, ...status };
      } else {
        const created = await api<{
          import_id: string;
          part_size: number;
          total_parts: number;
          uploaded_parts: number[];
        }>("/api/dashboard/knowledge-imports", {
          method: "POST",
          body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
        });
        nextJob = {
          import_id: created.import_id,
          filename: file.name,
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
          bytes_total: file.size,
        };
      }
      setJob(nextJob);
      const uploaded = new Set(nextJob.uploaded_parts);
      for (let partNumber = 0; partNumber < nextJob.total_parts; partNumber += 1) {
        if (uploaded.has(partNumber)) {
          continue;
        }
        const start = partNumber * nextJob.part_size;
        const part = file.slice(start, Math.min(file.size, start + nextJob.part_size));
        await uploadKnowledgeBundlePart(nextJob.import_id, partNumber, part, await sha256(part));
        uploaded.add(partNumber);
        const completed = summarizeUploadedParts({ fileSize: file.size, job: nextJob, uploaded });
        nextJob = {
          ...nextJob,
          parts_completed: uploaded.size,
          uploaded_parts: completed.uploadedParts,
          bytes_completed: completed.bytesCompleted,
        };
        setJob(nextJob);
      }
      await api(
        `/api/dashboard/knowledge-imports/${encodeURIComponent(nextJob.import_id)}/validate`,
        { method: "POST", body: "{}" },
      );
      setJob({ ...nextJob, status: "validating", phase: "manifest", bytes_completed: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Knowledge bundle upload failed");
    } finally {
      setWorking(false);
    }
  };

  const authorize = async () => {
    if (!job?.authentication_options) {
      return;
    }
    setWorking(true);
    setError("");
    try {
      const response = await startAuthentication({ optionsJSON: job.authentication_options });
      await api("/api/dashboard/knowledge-imports/confirm", {
        method: "POST",
        body: JSON.stringify({ intent_id: job.import_id, response }),
      });
      setJob({
        ...job,
        status: "restoring",
        phase: "objects",
        bytes_completed: 0,
        blobs_completed: 0,
        records_completed: 0,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Knowledge import authorization failed");
    } finally {
      setWorking(false);
    }
  };

  return {
    authorize,
    availabilityError,
    available,
    chooseFile: (nextFile: File | null) => {
      setFile(nextFile);
      setError("");
    },
    error,
    file,
    job,
    reset: () => {
      setJob(null);
      setFile(null);
    },
    upload,
    working,
  };
}

export type KnowledgeImportModel = ReturnType<typeof useKnowledgeImport>;
