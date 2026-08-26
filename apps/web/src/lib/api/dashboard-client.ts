import type { DashboardObjectSummary } from "@context-use/shared";
import { api, refreshCsrf } from "../../api.ts";
import type { Asset, DashboardSession } from "../../types.ts";

export const dashboardApi = {
  async session(): Promise<DashboardSession> {
    const session = await api<DashboardSession>("/api/dashboard/session");
    await refreshCsrf();
    return session;
  },

  assets(): Promise<Asset[]> {
    return api<Asset[]>("/api/dashboard/assets");
  },

  object({
    objectId,
    signal,
  }: {
    objectId: string;
    signal?: AbortSignal;
  }): Promise<DashboardObjectSummary> {
    return api<DashboardObjectSummary>(`/api/dashboard/objects/${encodeURIComponent(objectId)}`, {
      ...(signal ? { signal } : {}),
    });
  },
};
