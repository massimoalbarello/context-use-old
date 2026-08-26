import type { DashboardObjectSummary } from "@context-use/shared";
import { useState } from "react";
import { authClient } from "../../auth-client.ts";
import type { SidebarLayout } from "../../lib/hooks/use-sidebar-layout.ts";
import type { DashboardSession } from "../../types.ts";
import { ObjectNavigator } from "../ObjectNavigator.tsx";
import { CloseIcon, SectionIcon, SidebarToggleIcon, SignOutIcon } from "./workspace-icons.tsx";

export type Section = "knowledge" | "automations" | "history" | "settings";

type DashboardSidebarProps = {
  layout: SidebarLayout;
  navigatorRefresh: number;
  section: Section;
  selectedObjectId: string | null;
  session: DashboardSession;
  onCreate(): void;
  onNavigate(section: Section): void;
  onSelect(object: DashboardObjectSummary): void;
};

export function DashboardSidebar({
  layout,
  navigatorRefresh,
  section,
  selectedObjectId,
  session,
  onCreate,
  onNavigate,
  onSelect,
}: DashboardSidebarProps) {
  const [query, setQuery] = useState("");

  return (
    <>
      <header className="mobile-topbar">
        <button
          ref={layout.mobileSidebarToggleRef}
          type="button"
          className={`mobile-sidebar-toggle${layout.mobileSidebarOpen ? " active" : ""}`}
          aria-label={
            layout.mobileSidebarOpen ? "Close knowledge browser" : "Open knowledge browser"
          }
          aria-controls="knowledge-sidebar"
          aria-expanded={layout.mobileSidebarOpen}
          onClick={() => layout.setMobileSidebarOpen((open) => !open)}
        >
          <SidebarToggleIcon />
        </button>
        <strong className="mobile-current-section">
          {section[0]!.toUpperCase() + section.slice(1)}
        </strong>
      </header>
      <button
        type="button"
        className={`mobile-sidebar-scrim${layout.mobileSidebarOpen ? " open" : ""}`}
        aria-label="Close knowledge browser"
        tabIndex={-1}
        onClick={() => layout.setMobileSidebarOpen(false)}
      />
      <button
        type="button"
        className="sidebar-open-button"
        aria-label="Open knowledge browser"
        aria-controls="knowledge-sidebar"
        onClick={() => layout.setDesktopSidebarOpen(true)}
      >
        <SidebarToggleIcon />
      </button>
      <aside
        ref={layout.sidebarRef}
        id="knowledge-sidebar"
        className={`sidebar${layout.mobileSidebarOpen ? " mobile-open" : ""}`}
        aria-label="Knowledge browser"
      >
        <div className="sidebar-brand">
          <div className="brand-mark small">cu</div>
          <div className="sidebar-brand-copy">
            <strong>context-use</strong>
            <span>Private workspace</span>
          </div>
          <button
            type="button"
            className="sidebar-collapse-button"
            aria-label="Close knowledge browser"
            onClick={() => layout.setDesktopSidebarOpen(false)}
          >
            <SidebarToggleIcon />
          </button>
          <button
            ref={layout.mobileSidebarCloseRef}
            type="button"
            className="sidebar-close-button"
            aria-label="Close knowledge browser"
            onClick={() => layout.setMobileSidebarOpen(false)}
          >
            <CloseIcon />
          </button>
        </div>
        <label className="sidebar-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5" />
            <path d="m12.25 12.25 4 4" />
          </svg>
          <input
            ref={layout.searchRef}
            className="search"
            aria-label="Search knowledge"
            placeholder="Search knowledge…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>
        <ObjectNavigator
          query={query}
          selectedId={section === "knowledge" ? selectedObjectId : null}
          refreshToken={navigatorRefresh}
          onCreate={onCreate}
          onSelect={onSelect}
        />
        <footer>
          <nav className="sidebar-section-nav" aria-label="Workspace utilities">
            <button
              type="button"
              className={section === "automations" ? "active" : ""}
              onClick={() => onNavigate("automations")}
            >
              <SectionIcon section="automations" />
              <span>Automations</span>
            </button>
            <button
              type="button"
              className={section === "history" ? "active" : ""}
              onClick={() => onNavigate("history")}
            >
              <SectionIcon section="history" />
              <span>History</span>
            </button>
          </nav>
          <button
            type="button"
            className={section === "settings" ? "settings-button active" : "settings-button"}
            onClick={() => onNavigate("settings")}
          >
            <SectionIcon section="settings" />
            <span>Settings</span>
          </button>
          <div className="sidebar-account">
            <span className="user-avatar">{session.owner.email.slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-user">
              <strong>{session.owner.email}</strong>
              <small>
                {session.passkey_count} secure passkey{session.passkey_count === 1 ? "" : "s"}
              </small>
            </span>
            <button
              type="button"
              className="sign-out-button"
              onClick={() =>
                authClient.signOut({
                  fetchOptions: { onSuccess: () => location.assign("/app") },
                })
              }
            >
              <SignOutIcon />
              <span>Sign out</span>
            </button>
          </div>
        </footer>
      </aside>
      <hr
        className="sidebar-resizer"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={layout.minSidebarWidth}
        aria-valuemax={layout.maxSidebarWidth}
        aria-valuenow={layout.sidebarWidth}
        tabIndex={0}
        onPointerDown={layout.startResize}
        onKeyDown={layout.resizeWithKeyboard}
        onDoubleClick={() => layout.setSidebarWidth(layout.defaultSidebarWidth)}
      />
    </>
  );
}
