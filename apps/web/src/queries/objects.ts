import { queryOptions } from "@tanstack/react-query";
import { dashboardApi } from "../lib/api/dashboard-client.ts";

export const objectQueryKey = (objectId: string) => ["dashboard", "objects", objectId] as const;

export const objectQueryOptions = (objectId: string) =>
  queryOptions({
    queryKey: objectQueryKey(objectId),
    queryFn: ({ signal }) => dashboardApi.object({ objectId, signal }),
  });
