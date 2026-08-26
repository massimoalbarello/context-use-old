# Dashboard architecture

`apps/web` is the authenticated React dashboard. TanStack Router owns URL state and React Query owns
remote server state.

## Routes

`src/routes/` mirrors `/app` and contains one `RouteComponent` per route file. Route loaders and
guards handle authentication, redirects, and URL parameters. Do not call `history.pushState`, parse
`window.location.pathname`, or install `popstate` listeners in components.

Layout routes own shared chrome. The signed-in shell, standalone authentication pages, and OAuth
consent use separate route groups when their framing differs.

## Queries and hooks

- `src/queries/` owns API calls, query keys, and query-option factories.
- `src/lib/hooks/` owns mutations, effects, derived state, and reusable browser mechanics.
- Components do not call the API client directly.
- Mutation success invalidates the relevant query keys; do not add refresh counters or duplicate
  server responses into unrelated component state.
- API response types derive from the typed API client or query function. Do not add handwritten
  response mirrors.

## Components

`src/components/` contains one primary component per kebab-case file. Group components by the
feature or layout they serve.

A component should read primarily as markup. Extract a child when it owns behavior, state, or an
independently meaningful UI region. Reach for a hook before threading server or route state through
components that do not use it; retain props for decisions genuinely made by the parent.

Keep app-wide tokens and resets global. Component styles belong beside the component. Do not combine
an architectural refactor with a visual redesign or a new styling framework.

## Tests

Test accessible behavior and meaningful state transitions. Prefer queries by role and label. Do not
assert class lists, incidental element nesting, or hook implementation details.
