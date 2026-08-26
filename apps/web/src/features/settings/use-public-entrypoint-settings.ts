import { useEffect, useState } from "react";
import { api } from "../../api.ts";

export type PublicEntrypointCandidate = {
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

export function usePublicEntrypointSettings({ onMessage }: { onMessage(message: string): void }) {
  const [publicEntrypoint, setPublicEntrypoint] = useState<PublicEntrypoint | null>(null);
  const [publicEntrypointId, setPublicEntrypointId] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ entrypoint: PublicEntrypoint["entrypoint"] }>("/api/dashboard/publication-entrypoint"),
      api<{ candidates: PublicEntrypoint["candidates"] }>(
        "/api/dashboard/publication-entrypoint/candidates",
      ),
    ])
      .then(([entrypoint, candidates]) => {
        if (!active) {
          return;
        }
        setPublicEntrypoint({ ...entrypoint, ...candidates });
        setPublicEntrypointId(entrypoint.entrypoint.public_id ?? "");
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(
            caught instanceof Error ? caught.message : "Public entry point could not be loaded",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    setWorking(true);
    setError("");
    try {
      const result = await api<{ entrypoint: PublicEntrypoint["entrypoint"] }>(
        "/api/dashboard/publication-entrypoint",
        {
          method: "PUT",
          body: JSON.stringify({ public_id: publicEntrypointId || null }),
        },
      );
      setPublicEntrypoint((current) =>
        current ? { ...current, entrypoint: result.entrypoint } : current,
      );
      onMessage(publicEntrypointId ? "Public entry point updated." : "Public entry point removed.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Public entry point could not be updated",
      );
    } finally {
      setWorking(false);
    }
  };

  return {
    error,
    publicEntrypoint,
    publicEntrypointId,
    setPublicEntrypointId,
    save,
    working,
  };
}

export type PublicEntrypointSettingsModel = ReturnType<typeof usePublicEntrypointSettings>;
