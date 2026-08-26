import { queryOptions } from "@tanstack/react-query";
import { dashboardApi } from "../lib/api/dashboard-client.ts";

export const assetsQueryKey = ["dashboard", "assets"] as const;

export const assetsQueryOptions = () =>
  queryOptions({
    queryKey: assetsQueryKey,
    queryFn: () => dashboardApi.assets(),
  });
