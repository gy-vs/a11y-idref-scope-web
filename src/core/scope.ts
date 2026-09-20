import type {
  BoundaryKind,
  IdRefFinding,
  LocatedNode,
  ResolveStep,
  ResolvedToken,
  ScopeCandidate,
  ScopeInfo,
  SnapshotData,
  VDocument,
  VNode,
  VShadow,
} from './types';

// ---------------------------------------------------------------------------
// ARIA IDREF attributes
// ---------------------------------------------------------------------------

const IDREF_ATTRS = new Set([
  'aria-labelledby',
  'aria-describedby',
  'aria-details',
  'aria-controls',
  'aria-flowto',
  'aria-owns',
  'aria-activedescendant',
  'aria-errormessage',
  'for',
  'headers',
]);

// Attributes whose value is a whitespace separated token list.
const MULTI_TOKEN = new Set([
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-flowto',
  'aria-owns',
  'headers',
]);

export function isIdRefAttribute(name: string): boolean {
  return IDREF_ATTRS.has(name.toLowerCase());
}

export function isMultiToken(name: string): boolean {
  return MULTI_TOKEN.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Per-scope indexes
//
// One index per TreeScope (a document, an iframe document, or a shadow root).
// ARIA IDREFs resolve ONLY within the source element's own scope, so each index
// owns an independent id table. Duplicate ids inside one scope are kept as
// multiple entries and surfaced as an ambiguity diagnostic.
// ---------------------------------------------------------------------------

interface ScopeIndex {
  info: ScopeInfo;
  /** id -> sids carrying it, in tree order (length>1 => duplicate). */
  byId: Map<string, string[]>;
  /** sid -> parent sid within the same scope (scope root => null). */
  parent: Map<string, string | null>;
  /**
   * Scope-level fingerprint. It covers:
   *  - per-sid own data (tag + attributes) => catches attribute/structure edits
   *  - parent -> child edges within the scope => catches node MOVES, because a
   *    move rewires edges even though the moved node's own data is unchanged.
   * Light-DOM edges only; crossing a shadow/frame boundary opens a new scope.
   */
  digest: string;
  /** sids belonging to this scope. */
  sids: Set<string>;
  nodes: Map<string, VNode>;
}

export interface ScopeCacheState {
  revision: number;
  indexes: Map<string, ScopeIndex>;
  /** Scope keys whose indexes were (re)built for this revision. */
  rebuilt: string[];
}

export interface ScopedSnapshot {
  snapshot: SnapshotData;
  cache: ScopeCacheState;
  indexes: Map<string, ScopeIndex>;
}

// ---------------------------------------------------------------------------
// Scope construction + incremental invalidation
// ---------------------------------------------------------------------------

export function buildScopes(snapshot: SnapshotData, prev?: ScopeCacheState): ScopedSnapshot {
  // Revision unchanged: the captured tree cannot have changed; reuse as-is.
  if (prev && prev.revision === snapshot.revision) {
    return {snapshot, cache: {...prev, rebuilt: []}, indexes: prev.indexes};
  }

  // Build a descriptor of every scope directly from the snapshot. This is just
  // structural metadata; the (possibly cached) indexes are separate.
  const descriptors = collectScopes(snapshot);

  const invalidated = prev ? determineInvalidScopes(descriptors, prev) : null;

  const indexes = new Map<string, ScopeIndex>();
  const rebuilt: string[] = [];
  for (const desc of descriptors) {
    const cached = prev?.indexes.get(desc.info.scopeKey);
    const stale = !cached || !invalidated || invalidated.has(desc.info.scopeKey);
    if (stale) {
      rebuilt.push(desc.info.scopeKey);
      indexes.set(desc.info.scopeKey, buildIndex(desc));
    } else {
      indexes.set(desc.info.scopeKey, cached);
    }
  }

  const cache: ScopeCacheState = {revision: snapshot.revision, indexes, rebuilt};
  return {snapshot, cache, indexes};
}

interface ScopeDescriptor {
  info: ScopeInfo;
  roots: VNode[];
}

function collectScopes(snapshot: SnapshotData): ScopeDescriptor[] {
  const out: ScopeDescriptor[] = [];
  for (const doc of snapshot.documents) {
    out.push({
      info: {
        scopeKey: doc.scopeKey,
        kind: doc.kind === 'iframe' ? 'frame' : 'document',
        parentScopeKey: doc.hostSid ? findOwnerScopeKey(snapshot, doc.hostSid) : undefined,
        hostSid: doc.hostSid,
        label: doc.label,
      },
      roots: doc.children,
    });
    collectShadowScopes(doc.children, doc.scopeKey, out);
  }
  return out;
}

function collectShadowScopes(nodes: VNode[], parentScope: string, out: ScopeDescriptor[]): void {
  for (const node of nodes) {
    if (node.shadow) {
      out.push({
        info: {
          scopeKey: node.shadow.scopeKey,
          kind: node.shadow.mode === 'closed' ? 'shadow-closed' : 'shadow-open',
          parentScopeKey: parentScope,
          hostSid: node.shadow.hostSid,
          mode: node.shadow.mode,
        },
        roots: node.shadow.children,
      });
      collectShadowScopes(node.shadow.children, node.shadow.scopeKey, out);
    }
    collectShadowScopes(node.children, parentScope, out);
  }
}

/**
 * Decide which scopes must be rebuilt.
 *
 * A scope is invalid when:
 *   1. it did not exist in the previous cache (new boundary), or
 *   2. the set of sids it owns changed (a node moved into/out of the scope,
 *      including cross-iframe / cross-shadow moves), or
 *   3. a fingerprint for one of its sids changed (attribute / structure edit).
 *
 * Scopes unrelated to the mutated subtree keep byte-identical cached indexes.
 */
function determineInvalidScopes(
  descriptors: ScopeDescriptor[],
  prev: ScopeCacheState,
): Set<string> {
  const stale = new Set<string>();
  for (const desc of descriptors) {
    const key = desc.info.scopeKey;
    const cached = prev.indexes.get(key);
    if (!cached) {
      stale.add(key);
      continue;
    }
    const current = fingerprintScope(desc.roots);
    if (current.sids.size !== cached.sids.size || current.digest !== cached.digest) {
      stale.add(key);
    }
  }
  // Scopes that disappeared invalidate nothing on their own, but any scope
  // whose host moved is caught above by sid-ownership change.
  return stale;
}

function buildIndex(desc: ScopeDescriptor): ScopeIndex {
  const idx: ScopeIndex = {
    info: desc.info,
    byId: new Map(),
    parent: new Map(),
    digest: '',
    sids: new Set(),
    nodes: new Map(),
  };
  indexChildren(desc.roots, null, idx);
  idx.digest = computeDigest(desc.roots);
  return idx;
}

function indexChildren(nodes: VNode[], parentSid: string | null, idx: ScopeIndex): void {
  for (const node of nodes) {
    idx.sids.add(node.sid);
    idx.nodes.set(node.sid, node);
    idx.parent.set(node.sid, parentSid);
    const id = node.attrs.id;
    if (typeof id === 'string' && id.length > 0) {
      const list = idx.byId.get(id);
      if (list) list.push(node.sid);
      else idx.byId.set(id, [node.sid]);
    }
    // Light children remain in the same scope; a shadow root opens a new one
    // (handled by collectShadowScopes), so do not descend into it here.
    indexChildren(node.children, node.sid, idx);
  }
}

/** Own-data fingerprint of a single node (excludes descendants). */
function ownDigest(node: VNode): string {
  return (
    node.sid +
    '|' +
    node.tag +
    '|' +
    JSON.stringify(node.attrs) +
    (node.shadow ? '|#' + node.shadow.scopeKey + ':' + node.shadow.mode : '')
  );
}

/**
 * Whole-scope digest: every node's own data plus every in-scope parent->child
 * edge. Sorted so digest equality is independent of Map iteration order and
 * reflects only content/structure.
 */
function computeDigest(roots: VNode[]): string {
  const parts: string[] = [];
  const walk = (nodes: VNode[], parent: string | null) => {
    for (const n of nodes) {
      parts.push('n:' + ownDigest(n));
      parts.push('e:' + (parent ?? '∅') + '>' + n.sid);
      walk(n.children, n.sid); // light DOM only; shadow is a separate scope
    }
  };
  walk(roots, null);
  return parts.sort().join('\n');
}

function fingerprintScope(roots: VNode[]): {sids: Set<string>; digest: string} {
  const sids = new Set<string>();
  const walk = (nodes: VNode[]) => {
    for (const n of nodes) {
      sids.add(n.sid);
      walk(n.children); // light DOM only; shadow is a separate scope
    }
  };
  walk(roots);
  return {sids, digest: computeDigest(roots)};
}

/** Locate the scope that owns a host sid (the scope in which it is light DOM). */
function findOwnerScopeKey(snapshot: SnapshotData, hostSid: string): string | undefined {
  // Search every document; sids are globally unique so the host can only ever
  // resolve inside its real parent (possibly a nested shadow scope).
  for (const doc of snapshot.documents) {
    const owner = ownerScopeInDoc(doc, hostSid);
    if (owner) return owner;
  }
  return undefined;
}

function ownerScopeInDoc(doc: VDocument, sid: string): string | undefined {
  let owner: string | undefined;
  const visit = (nodes: VNode[], shadow: VShadow | null): boolean => {
    for (const n of nodes) {
      if (n.sid === sid) {
        owner = shadow ? shadow.scopeKey : doc.scopeKey;
        return true;
      }
      if (n.shadow && visit(n.shadow.children, n.shadow)) return true;
      if (visit(n.children, shadow)) return true;
    }
    return false;
  };
  visit(doc.children, null);
  return owner;
}

// ---------------------------------------------------------------------------
// IDREF analysis
// ---------------------------------------------------------------------------

export function analyzeIdRefs(scoped: ScopedSnapshot): IdRefFinding[] {
  const {snapshot, indexes} = scoped;
  const findings: IdRefFinding[] = [];

  for (const doc of snapshot.documents) {
    analyzeTree(doc.scopeKey, doc.children, [], indexes, findings);
  }
  return findings;
}

function analyzeTree(
  scopeKey: string,
  nodes: VNode[],
  ancestorPath: ResolveStep[],
  indexes: Map<string, ScopeIndex>,
  findings: IdRefFinding[],
): void {
  for (const node of nodes) {
    const herePath = ancestorPath.concat({sid: node.sid});
    for (const [attr, raw] of Object.entries(node.attrs)) {
      if (!isIdRefAttribute(attr)) continue;
      const tokens = splitTokens(raw, isMultiToken(attr));
      const resolved = tokens.map((token) => resolveToken(scopeKey, token, indexes));
      findings.push({
        sourceSid: node.sid,
        attribute: attr,
        multi: isMultiToken(attr),
        severity: worstSeverity(resolved),
        sourcePath: herePath,
        tokens: resolved,
      });
    }
    analyzeTree(scopeKey, node.children, herePath, indexes, findings);
    if (node.shadow) {
      const edge: ResolveStep = {
        sid: node.sid,
        boundary: node.shadow.mode === 'closed' ? 'shadow-closed' : 'shadow-open',
        hostSid: node.sid,
        scopeKey: node.shadow.scopeKey,
      };
      analyzeTree(node.shadow.scopeKey, node.shadow.children, ancestorPath.concat(edge), indexes, findings);
    }
  }
}

function worstSeverity(tokens: ResolvedToken[]): IdRefFinding['severity'] {
  if (tokens.some((t) => t.status === 'missing' || t.status === 'empty')) return 'missing';
  if (tokens.some((t) => t.status === 'ambiguous')) return 'ambiguous';
  if (tokens.some((t) => t.status === 'cross-scope')) return 'unreachable';
  return 'ok';
}

function splitTokens(raw: string, multi: boolean): string[] {
  if (!multi) return [raw];
  return raw.trim().length === 0 ? [''] : raw.split(/[ \t\r\n\f]+/);
}

/**
 * Resolve one token against the source's owning TreeScope.
 *
 * - several in-scope elements share the id => ambiguous (all candidates)
 * - one in-scope element => resolved, with a stable-id path
 * - none in scope but an equal id exists behind a shadow/frame boundary =>
 *   cross-scope (the boundary the old global map incorrectly crossed)
 * - nowhere => missing
 */
function resolveToken(
  sourceScope: string,
  token: string,
  indexes: Map<string, ScopeIndex>,
): ResolvedToken {
  if (token === '') return {token, status: 'empty'};
  const idx = indexes.get(sourceScope)!;
  const local = idx.byId.get(token);

  if (local && local.length > 0) {
    const path = buildPath(local[0], sourceScope, indexes);
    if (local.length > 1) {
      return {
        token,
        status: 'ambiguous',
        candidates: local.slice(),
        blockedBy: findCrossScope(token, sourceScope, indexes),
        path,
      };
    }
    return {token, status: 'resolved', sid: local[0], path};
  }

  const blocked = findCrossScope(token, sourceScope, indexes);
  if (blocked.length > 0) return {token, status: 'cross-scope', blockedBy: blocked};
  return {token, status: 'missing'};
}

function findCrossScope(
  token: string,
  sourceScope: string,
  indexes: Map<string, ScopeIndex>,
): ScopeCandidate[] {
  const out: ScopeCandidate[] = [];
  for (const [key, idx] of indexes) {
    if (key === sourceScope) continue;
    const hit = idx.byId.get(token);
    if (hit && hit.length > 0) {
      out.push({scopeKey: key, kind: idx.info.kind, sid: hit[0]});
    }
  }
  out.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
  return out;
}

// ---------------------------------------------------------------------------
// Stable-id resolution path (top document -> target), replayable on a snapshot
// ---------------------------------------------------------------------------

export function buildPath(
  targetSid: string,
  targetScope: string,
  indexes: Map<string, ScopeIndex>,
): ResolveStep[] {
  // Scope chain from the top document down to the target scope.
  const scopeChain: string[] = [];
  let cur: string | undefined = targetScope;
  const seenScopes = new Set<string>();
  while (cur && !seenScopes.has(cur)) {
    seenScopes.add(cur);
    scopeChain.unshift(cur);
    if (cur === '#document') break;
    cur = indexes.get(cur)?.info.parentScopeKey;
  }

  const steps: ResolveStep[] = [];
  for (let i = 0; i < scopeChain.length; i++) {
    const scopeKey = scopeChain[i];
    const idx = indexes.get(scopeKey)!;
    const isLast = i === scopeChain.length - 1;
    const goal = isLast ? targetSid : indexes.get(scopeChain[i + 1])!.info.hostSid!;

    // Element chain inside this scope. For a boundary crossing we walk down to
    // the host's PARENT and let the boundary step name the host exactly once;
    // in the final scope we walk all the way to the target.
    const els: string[] = [];
    let node: string | null = isLast ? goal : idx.parent.get(goal) ?? null;
    const guard = new Set<string>();
    while (node && !guard.has(node)) {
      guard.add(node);
      els.unshift(node);
      node = idx.parent.get(node) ?? null;
    }
    for (const sid of els) steps.push({sid});

    if (!isLast) {
      const childKey = scopeChain[i + 1];
      const child = indexes.get(childKey)!.info;
      steps.push({boundary: child.kind, hostSid: goal, scopeKey: childKey, sid: goal});
    }
  }
  return steps;
}

export function scopeInfos(scoped: ScopedSnapshot): ScopeInfo[] {
  return [...scoped.indexes.values()].map((i) => i.info);
}

// ---------------------------------------------------------------------------
// Frontend-only replay: locate a snapshot node from a stable path.
// Never touches the live workbench document (no getElementById/querySelector).
// ---------------------------------------------------------------------------

export function locateByPath(
  snapshot: SnapshotData,
  targetSid: string,
  path: ResolveStep[],
  revision: number,
): LocatedNode {
  const owner = new Map<string, string>(); // sid -> scope
  for (const doc of snapshot.documents) {
    indexOwners(doc.children, doc.scopeKey, owner);
  }

  let currentScope = '#document';
  const boundaryKinds: BoundaryKind[] = [];
  for (const step of path) {
    if (step.boundary) {
      if (!step.scopeKey || owner.get(step.hostSid ?? '') !== currentScope) {
        return {found: false, sid: step.hostSid ?? targetSid, scopeKey: currentScope, path, revision, liveRevealable: false, boundaryKinds};
      }
      currentScope = step.scopeKey;
      boundaryKinds.push(step.boundary);
      continue;
    }
    if (step.sid && owner.get(step.sid) !== currentScope) {
      return {found: false, sid: step.sid, scopeKey: currentScope, path, revision, liveRevealable: false, boundaryKinds};
    }
  }

  const found = owner.get(targetSid) === currentScope;
  return {
    found,
    sid: targetSid,
    scopeKey: currentScope,
    path,
    revision,
    // A path crossing a closed shadow root can be replayed on the snapshot but
    // can never be revealed in a live browser.
    liveRevealable: !boundaryKinds.includes('shadow-closed'),
    boundaryKinds,
  };
}

function indexOwners(nodes: VNode[], scopeKey: string, owner: Map<string, string>): void {
  for (const n of nodes) {
    owner.set(n.sid, scopeKey);
    indexOwners(n.children, scopeKey, owner);
    if (n.shadow) indexOwners(n.shadow.children, n.shadow.scopeKey, owner);
  }
}
