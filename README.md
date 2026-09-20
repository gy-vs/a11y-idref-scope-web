# Accessibility Review — scoped ARIA IDREF workbench

Local workbench for reviewing ARIA IDREF resolution (`aria-labelledby`,
`aria-describedby`, `aria-controls`, `aria-flowto`, `aria-owns`,
`aria-errormessage`, `aria-details`, `aria-activedescendant`, `for`, `list`)
across real DOM reachability boundaries.

## Why

A global server-side `id -> node` map and live `getElementById` lookups in the
browser contradict each other once a page contains duplicate ids, iframes or
shadow roots:

- duplicate ids silently resolve to whichever node was inserted last/first in
  the global map;
- the browser resolves IDREFs per tree scope and cannot enter a shadow root or
  iframe document;
- closed shadow roots are invisible to workbench JS entirely.

This project resolves IDREFs server-side against a serialized **snapshot** and
the client only locates nodes from that snapshot using stable node ids (`nid`)
— it never queries the workbench's own DOM by id.

## Scope model (document / iframe / shadow root)

Each of the following owns an independent id namespace (`src/core/traverse.ts`):

1. the top document;
2. every shadow root — open **and** closed (closed roots exist in the captured
   accessibility snapshot even though live JS cannot enter them);
3. every iframe content document.

IDREFs resolve only inside the referencing element's own scope. Same-id nodes
behind a shadow/frame boundary are reported as **unreachable** (with the
blocking boundary: `shadow(open|closed)@host` / `iframe@frame`), never silently
resolved. Duplicate ids inside one scope make a token **ambiguous**; every
candidate is returned and the first match in tree order is marked `effective`
(what browser accessible-name computation consumes).

Server results carry, per token: status (`ok` / `ambiguous` / `missing`),
target stable `nid`s and full boundary-aware paths, plus unreachable
alternatives. The client highlights snapshot nodes by `nid` only.

## Scope index cache

The analyzer (`src/core/resolver.ts`) keeps one id index per scope. An index is
reused unless that **scope root's revision** changed; revisions are bumped only
by id-relevant edits:

- unrelated attribute change (class / aria-* / …): only the element rev bumps
  — zero indexes rebuilt;
- `id` attribute change: only the owning scope rebuilds;
- insert / remove: only the containing scope;
- move across a boundary: exactly the old and new scopes (one scope for an
  in-scope move);
- removed scopes (e.g. an iframe deleted) are evicted.

The `/analyze` and `/mutate` responses include `cache: {rebuilt, reused}`.

## API

- `GET /api/pages` — snapshot list with revisions
- `GET /api/pages/:id` — snapshot JSON
- `POST /api/pages/:id/analyze` `{revision}` — scoped findings + cache stats
- `POST /api/pages/:id/mutate` `{revision, op}` — apply `set-attr` / `move` /
  `insert` / `remove`, returns the new snapshot, revision, fresh analysis and
  cache stats (409 on stale revision)

## Run

```bash
npm install
npm test        # vitest: scope resolution + cache invalidation + API
npm run build   # tsc + vite production build
npm run dev     # tsx server (4174) + vite (4173)
```

Demo snapshot (`src/core/fixtures.ts`) covers duplicate ids, multi-token
attributes, missing targets, open/closed shadow roots, cross-iframe id reuse
and node moves.
