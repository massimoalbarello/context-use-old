import { useQuery } from "@tanstack/react-query";
import { Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { authClient } from "./auth-client.ts";
import { DashboardShell } from "./components/layout/DashboardShell.tsx";
import { Login } from "./components/Login.tsx";
import { sessionQueryOptions } from "./queries/session.ts";

export function App() {
  const { data: authSession, isPending } = authClient.useSession();
  const matchRoute = useMatchRoute();
  const consent = Boolean(matchRoute({ to: "/app/oauth/consent" }));
  const [sessionResolved, setSessionResolved] = useState(false);
  const sessionQuery = useQuery({
    ...sessionQueryOptions(),
    enabled: Boolean(authSession),
  });
  const session = sessionQuery.data ?? null;

  useEffect(() => {
    if (!isPending) {
      setSessionResolved(true);
    }
  }, [isPending]);

  // Only the first session lookup replaces the page. A failed passkey attempt
  // makes Better Auth re-read the session, and swapping in a loading screen
  // would unmount Login and discard the error it just set.
  if (isPending && !sessionResolved) {
    return <main className="center-card">Loading…</main>;
  }
  if (!authSession) {
    return <Login />;
  }
  if (consent) {
    return <Outlet />;
  }
  if (!session) {
    return <main className="center-card">Verifying owner session…</main>;
  }
  if (session.passkey_count === 0) {
    return (
      <main className="center-card">
        <h1>Owner passkey missing</h1>
        <p>This installation must always retain at least one owner passkey.</p>
      </main>
    );
  }

  return (
    <DashboardShell session={session} reloadSession={async () => void (await sessionQuery.refetch())} />
  );
}
