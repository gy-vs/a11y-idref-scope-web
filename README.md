# Accessibility Review

Local workbench for review findings, with a scoped ARIA IDREF analyzer.

Run `npm install`, then `npm run dev` (API on `:4174`, UI on `:4173`).
`npm test` runs the suite; `npm run build` type-checks and bundles.

## The problem this solves

The old analyzer kept **all** element ids in one global map. A reference in one
component resolved to a same-id element in a completely different component,
iframe, or shadow tree; after entering a shadow root the in-scope target could
no longer be found. Meanwhile the detail view queried the *browser's current
document*, so the server and browser disagreed.

The fix models **TreeScope** boundaries explicitly and resolves every ARIA
IDREF inside its source scope.

## Scope model

A captured page (`SnapshotData`) is plain serializable data made of:

- `VDocument` — the top document (`#document`) and each same-document iframe
  (`kind: 'iframe'`, linked to its host element by `hostSid`).
- `VShadow` — a shadow root attached to a host (`mode: 'open' | 'closed'`).
- `VNode` — an element with a **stable id `sid`** (independent of the `id`
  attribute and of tree position), attributes, light children, and an optional
  shadow root.

Each document / shadow root is one scope. IDREF resolution rules:

1. **Resolve only in the source element's scope.** `aria-labelledby`,
   `aria-describedby`, etc. never cross a shadow or iframe boundary.
2. Token lists (`aria-labelledby`, `aria-describedby`, `headers`, …) are split
   on whitespace and resolved token by token.
3. **Duplicate id in one scope** ⇒ `ambiguous`, with every candidate sid.
4. No in-scope match, but an equal id exists behind a boundary ⇒ `cross-scope`,
   listing the blocked scopes (the old global map incorrectly picked these).
5. No match anywhere ⇒ `missing`; a blank slot ⇒ `empty`.

Each resolved token carries a **stable-id `path`** from the top document to the
target. A path is a list of element steps plus explicit boundary steps
(`frame` / `shadow-open` / `shadow-closed`, each naming its host sid), so it can
be replayed without any live DOM.

## Server result, snapshot-only frontend

- `GET /api/snapshot` — the built-in captured page (duplicate ids, a
  multi-token reference, a missing target, an iframe, and open + closed
  shadows).
- `POST /api/snapshot/analyze` — body is a `SnapshotData`; returns findings,
  scopes, and stats. Targets are **stable sids + paths**, never live nodes.
- The frontend (`src/client/locate.ts`) only **replays the returned path
  against the snapshot**. It never calls `getElementById` / `querySelector`,
  so it cannot accidentally read the workbench's own DOM. A path through a
  **closed** shadow root is reported `liveRevealable: false` — visible in the
  snapshot, not revealable in a live browser.

## Scoped cache invalidation

`buildScopes(snapshot, prevCache)` keeps one index per scope. When the revision
advances a scope is rebuilt only when:

- it is newly created / removed,
- the set of sids it owns changed (a node **moved into or out of** the scope,
  including cross-iframe / cross-shadow moves), or
- its scope digest changed (an attribute/structure edit, or a rewired
  parent→child edge — which also catches same-scope moves).

A change deep inside one document subtree rebuilds just that one scope; sibling
frames and shadow trees keep their indexes. `stats.invalidatedScopes` reports
exactly which scopes were rebuilt. An unchanged revision reuses everything.

## Layout

- `src/core/types.ts` — snapshot + result types.
- `src/core/scope.ts` — scope indexes, resolution, path building/replay, and
  incremental invalidation.
- `src/core/analyze.ts` — analysis facade + stats.
- `src/core/builder.ts` — snapshot construction and revision/mutation helpers.
- `src/server/` — Express endpoints and the demo snapshot.
- `src/client/` — React workbench (snapshot tree, findings, path replay).
- `test/` — scope rules, cache invalidation, and API tests.
