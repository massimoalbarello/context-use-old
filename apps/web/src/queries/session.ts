import { queryOptions } from "@tanstack/react-query";
import { dashboardApi } from "../lib/api/dashboard-client.ts";

export const sessionQueryKey = ["dashboard", "session"] as const;

export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: sessionQueryKey,
    queryFn: () => dashboardApi.session(),
  });
