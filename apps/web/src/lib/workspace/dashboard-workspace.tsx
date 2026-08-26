import type { DashboardObjectSummary } from "@context-use/shared";
import { createContext, type ReactNode, useContext } from "react";
import type { DashboardSession } from "../../types.ts";

export type DashboardWorkspace = {
  session: DashboardSession;
  navigatorRefresh: number;
  openObject(input: { object: DashboardObjectSummary; fragment?: string }): void;
  openObjectId(input: { objectId: string; fragment?: string }): void;
  reloadSession(): Promise<void>;
  refreshNavigator(): void;
  showMessage(message: string): void;
};

const DashboardWorkspaceContext = createContext<DashboardWorkspace | null>(null);

export function DashboardWorkspaceProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: DashboardWorkspace;
}) {
  return (
    <DashboardWorkspaceContext.Provider value={value}>
      {children}
    </DashboardWorkspaceContext.Provider>
  );
}

export function useDashboardWorkspace(): DashboardWorkspace {
  const value = useContext(DashboardWorkspaceContext);
  if (!value) {
    throw new Error("Dashboard workspace context is unavailable");
  }
  return value;
}
