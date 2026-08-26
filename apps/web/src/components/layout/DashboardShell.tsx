import type { DashboardObjectSummary } from "@context-use/shared";
import { Outlet, useMatchRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, type MouseEvent, useEffect, useState } from "react";
import { useSidebarLayout } from "../../lib/hooks/use-sidebar-layout.ts";
import { queryClient } from "../../lib/query-client.ts";
import {
  type DashboardWorkspace,
  DashboardWorkspaceProvider,
} from "../../lib/workspace/dashboard-workspace.tsx";
import { objectQueryKey } from "../../queries/objects.ts";
import type { DashboardSession } from "../../types.ts";
import { DashboardSidebar, type Section } from "./DashboardSidebar.tsx";

type DashboardShellProps = {
  session: DashboardSession;
  reloadSession(): Promise<void>;
};

const sectionPath: Record<Exclude<Section, "knowledge">, string> = {
  automations: "/app/automations",
  history: "/app/history",
  settings: "/app/settings",
};

export function DashboardShell({ session, reloadSession }: DashboardShellProps) {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const layout = useSidebarLayout();
  const objectMatch = matchRoute({ to: "/app/objects/$objectId" });
  const selectedObjectId = objectMatch ? objectMatch.objectId : null;
  const section: Section = matchRoute({ to: "/app/settings" })
    ? "settings"
    : matchRoute({ to: "/app/automations" })
      ? "automations"
      : matchRoute({ to: "/app/history" })
        ? "history"
        : "knowledge";
  const [navigatorRefresh, setNavigatorRefresh] = useState(0);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (pathname) {
      layout.setMobileSidebarOpen(false);
    }
  }, [pathname, layout.setMobileSidebarOpen]);

  const openObject = ({
    object,
    fragment = "",
  }: {
    object: DashboardObjectSummary;
    fragment?: string;
  }) => {
    queryClient.setQueryData(objectQueryKey(object.object_id), object);
    layout.setMobileSidebarOpen(false);
    void navigate({
      to: "/app/objects/$objectId",
      params: { objectId: object.object_id },
      hash: fragment.replace(/^#/, ""),
    });
  };

  const openObjectId = ({ objectId, fragment = "" }: { objectId: string; fragment?: string }) => {
    layout.setMobileSidebarOpen(false);
    void navigate({
      to: "/app/objects/$objectId",
      params: { objectId },
      hash: fragment.replace(/^#/, ""),
    });
  };

  const workspace: DashboardWorkspace = {
    session,
    navigatorRefresh,
    openObject,
    openObjectId,
    reloadSession,
    refreshNavigator: () => setNavigatorRefresh((value) => value + 1),
    showMessage: setMessage,
  };

  const navigateToSection = (nextSection: Section) => {
    layout.setMobileSidebarOpen(false);
    if (nextSection === "knowledge") {
      void navigate({ to: "/app" });
      return;
    }
    void navigate({ to: sectionPath[nextSection] });
  };

  const followObjectLink = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!(target instanceof HTMLAnchorElement) || target.target === "_blank") {
      return;
    }
    const url = new URL(target.href, window.location.href);
    const match =
      url.origin === window.location.origin
        ? /^\/app\/(?:objects|pages|assets|records)\/([0-9a-f-]{36})$/.exec(url.pathname)
        : null;
    if (!match) {
      return;
    }
    event.preventDefault();
    openObjectId({ objectId: match[1]!, fragment: url.hash });
  };

  return (
    <DashboardWorkspaceProvider value={workspace}>
      <div
        className={`shell${layout.desktopSidebarOpen ? "" : " sidebar-collapsed"}`}
        style={{ "--sidebar-width": `${layout.sidebarWidth}px` } as CSSProperties}
        onClickCapture={followObjectLink}
      >
        <DashboardSidebar
          layout={layout}
          navigatorRefresh={navigatorRefresh}
          section={section}
          selectedObjectId={selectedObjectId}
          session={session}
          onCreate={() => void navigate({ to: "/app/objects/new" })}
          onNavigate={navigateToSection}
          onSelect={(object) => openObject({ object })}
        />
        <Outlet />
        {message && <div className="toast">{message}</div>}
      </div>
    </DashboardWorkspaceProvider>
  );
}
