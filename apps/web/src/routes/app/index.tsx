import { createRoute } from "@tanstack/react-router";
import { appRoute } from "./route.tsx";

function DashboardHome() {
  return (
    <main className="editor-empty">
      <div className="empty-content">
        <span className="empty-kicker">
          <i />
          Private by default
        </span>
        <h1>
          Your context,
          <br />
          ready when you need it.
        </h1>
        <p>
          Search your knowledge, open an object, then follow its links and backlinks. Your content
          stays private until you explicitly publish an exact version.
        </p>
        <div className="empty-details">
          <span>Search-first</span>
          <span>Hyperlinked</span>
          <span>Versioned history</span>
        </div>
      </div>
      <div className="empty-sigil" aria-hidden="true">
        <span>c</span>
        <span>u</span>
      </div>
    </main>
  );
}

export const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardHome,
});
