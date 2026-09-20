/**
 * Scoped ARIA IDREF resolution.
 *
 * Reachability rules (matching DOM tree scopes / ARIA):
 *  - Every document (top document and every iframe content document) and
 *    every shadow root (open *and* closed — closed roots exist in the
 *    captured snapshot even though live JS could not see them) owns an
 *    independent id namespace.
 *  - IDREFs resolve only inside the referencing node's own scope. They
 *    never cross a shadow boundary or a frame boundary, in either
 *    direction (light DOM <-> shadow tree, parent frame <-> iframe).
 *  - Duplicate ids inside one scope make the reference ambiguous; browser
 *    name computation uses the first element in tree order, the audit
 *    reports every candidate.
 *  - When no same-scope target exists but an identical id exists behind a
 *    boundary, that node is reported as an unreachable alternative rather
 *    than silently resolved (the failure mode of a global id map).
 *
 * The per-scope id indexes are cached. A cached index for a scope is reused
 * unless that scope's root revision changed; the root revision is bumped
 * only by id-relevant edits (id attribute change, child insert/remove,
 * move in/out of the scope). Editing an unrelated attribute deep in the
 * subtree bumps only that element's revision, so no index is rebuilt.
 */
import type {ShadowMode, Snapshot, SnapshotNode} from './types';
import {buildTreeInfo, pathToNode, type ScopeBoundary, type TreeInfo} from './traverse';

/** Attributes whose value is a whitespace-separated IDREF list. */
export const IDREF_LIST_ATTRS = new Set([
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-flowto',
  'aria-owns',
]);

/** Attributes whose value is a single IDREF. */
export const IDREF_SINGLE_ATTRS = new Set([
  'aria-errormessage',
  'aria-details',
  'aria-activedescendant',
  'for',
  'list',
]);

export type TokenStatus = 'ok' | 'ambiguous' | 'missing';
export type Severity = 'ok' | 'ambiguous' | 'missing' | 'mixed';

export interface ResolvedTarget {
  nid: string;
  tag: string;
  id: string;
  /** Boundary-aware structural path from the snapshot root. */
  path: string[];
  /** Browsers feed the first match in tree order to name computation. */
  effective: boolean;
}

export interface UnreachableMatch {
  nid: string;
  scopeNid: string;
  id: string;
  /** Boundary that separates the referencing scope from this candidate. */
  blockedBy: {kind: 'shadow'; host: string; mode: ShadowMode} | {kind: 'iframe'; iframe: string};
  path: string[];
}

export interface TokenResolution {
  token: string;
  index: number;
  status: TokenStatus;
  targets: ResolvedTarget[];
  /** Same-id nodes living in other scopes — never valid targets. */
  unreachable: UnreachableMatch[];
  duplicateToken?: boolean;
}

export interface Finding {
  attribute: string;
  sourceNid: string;
  sourceTag: string;
  sourcePath: string[];
  scopeNid: string;
  scopeBoundary: ScopeBoundary[];
  tokens: TokenResolution[];
  severity: Severity;
}

export interface DuplicateIdReport {
  id: string;
  scopeNid: string;
  scopeBoundary: ScopeBoundary[];
  nodes: {nid: string; tag: string; path: string[]}[];
}

export interface AnalysisSummary {
  scopes: number;
  shadowScopes: number;
  frameScopes: number;
  elements: number;
  references: number;
  ok: number;
  ambiguous: number;
  missing: number;
  duplicateIdGroups: number;
}

export interface AnalysisResult {
  revision: number;
  summary: AnalysisSummary;
  findings: Finding[];
  duplicateIds: DuplicateIdReport[];
}

interface CachedIndex {
  /** Scope root revision this index was built against. */
  sig: number;
  idIndex: Map<string, SnapshotNode[]>;
  elements: number;
}

export interface CacheStats {
  /** Scope nids whose index had to be rebuilt for the last analysis. */
  rebuilt: string[];
  /** Scope nids whose cached index was reused. */
  reused: string[];
}

export class ScopeAnalyzer {
  private cache = new Map<string, CachedIndex>();
  readonly stats: CacheStats = {rebuilt: [], reused: []};

  analyze(snapshot: Snapshot): AnalysisResult {
    const info = buildTreeInfo(snapshot.root);
    this.stats.rebuilt = [];
    this.stats.reused = [];

    for (const [scopeNid, scope] of info.scopes) {
      const cached = this.cache.get(scopeNid);
      if (cached && cached.sig === scope.root.rev) {
        this.stats.reused.push(scopeNid);
        continue;
      }
      this.cache.set(scopeNid, {sig: scope.root.rev, ...this.buildIndex(scope.root)});
      this.stats.rebuilt.push(scopeNid);
    }
    // Evict scopes that disappeared (e.g. an iframe host was removed).
    for (const cachedScope of this.cache.keys()) {
      if (!info.scopes.has(cachedScope)) this.cache.delete(cachedScope);
    }

    return this.collect(snapshot, info);
  }

  /** id -> elements holding it, in tree order, without leaving the scope. */
  private buildIndex(scopeRoot: SnapshotNode): {idIndex: Map<string, SnapshotNode[]>; elements: number} {
    const idIndex = new Map<string, SnapshotNode[]>();
    let elements = 0;
    // Scope roots (document / shadow nodes) themselves hold no id.
    for (const child of scopeRoot.children ?? []) indexSubtree(child);
    function indexSubtree(node: SnapshotNode) {
      if (node.kind === 'element') {
        elements += 1;
        const id = node.attrs?.id;
        if (id !== undefined && id !== '') {
          const list = idIndex.get(id);
          if (list) list.push(node);
          else idIndex.set(id, [node]);
        }
      }
      // Only regular children stay in this scope. A host's shadow root and an
      // iframe's content document are separate scopes with their own indexes;
      // descending here would leak nested ids into the parent's id map.
      for (const child of node.children ?? []) indexSubtree(child);
    }
    return {idIndex, elements};
  }

  private indexFor(info: TreeInfo, scopeNid: string): CachedIndex {
    const cached = this.cache.get(scopeNid);
    if (!cached) throw new Error(`index missing for scope ${scopeNid}`);
    return cached;
  }

  private collect(snapshot: Snapshot, info: TreeInfo): AnalysisResult {
    const findings: Finding[] = [];
    const duplicateIds: DuplicateIdReport[] = [];
    let shadowScopes = 0;
    let frameScopes = 0;
    let elements = 0;
    let references = 0;
    let okCount = 0;
    let ambiguousCount = 0;
    let missingCount = 0;

    // Duplicate ids per scope.
    for (const [scopeNid, scope] of info.scopes) {
      if (scope.shadowMode) shadowScopes += 1;
      if (scope.boundary.some(b => b.kind === 'iframe')) frameScopes += 1;
      elements += this.indexFor(info, scopeNid).elements;
      for (const [id, nodes] of this.indexFor(info, scopeNid).idIndex) {
        if (nodes.length > 1) {
          duplicateIds.push({
            id,
            scopeNid,
            scopeBoundary: scope.boundary,
            nodes: nodes.map(node => ({
              nid: node.nid,
              tag: node.tag ?? 'unknown',
              path: pathToNode(snapshot.root, node.nid),
            })),
          });
        }
      }
    }

    // IDREF attributes on every element, resolved inside its own scope.
    for (const [nid, node] of info.nodes) {
      if (node.kind !== 'element' || !node.attrs) continue;
      const scopeNid = info.scopeOf.get(nid)!;
      const scopeInfo = info.scopes.get(scopeNid)!;
      for (const attr of IDREF_LIST_ATTRS) {
        if (node.attrs[attr] !== undefined) {
          findings.push(this.buildFinding(snapshot, info, node, attr, node.attrs[attr], false, scopeNid, scopeInfo.boundary));
        }
      }
      for (const attr of IDREF_SINGLE_ATTRS) {
        if (node.attrs[attr] !== undefined) {
          findings.push(this.buildFinding(snapshot, info, node, attr, node.attrs[attr], true, scopeNid, scopeInfo.boundary));
        }
      }
    }

    for (const finding of findings) {
      references += finding.tokens.length;
      const statuses = new Set(finding.tokens.map(t => t.status));
      if (statuses.has('missing') && (statuses.has('ambiguous') || statuses.has('ok'))) {
        finding.severity = 'mixed';
      } else if (statuses.has('missing')) {
        finding.severity = 'missing';
      } else if (statuses.has('ambiguous')) {
        finding.severity = 'ambiguous';
      } else {
        finding.severity = 'ok';
      }
      // Token-level counts are independent of the finding's overall severity.
      for (const token of finding.tokens) {
        if (token.status === 'ok') okCount += 1;
        else if (token.status === 'ambiguous') ambiguousCount += 1;
        else missingCount += 1;
      }
    }

    findings.sort((a, b) => a.sourcePath.join('>').localeCompare(b.sourcePath.join('>')) || a.attribute.localeCompare(b.attribute));

    return {
      revision: snapshot.revision,
      summary: {
        scopes: info.scopes.size,
        shadowScopes,
        frameScopes,
        elements,
        references,
        ok: okCount,
        ambiguous: ambiguousCount,
        missing: missingCount,
        duplicateIdGroups: duplicateIds.length,
      },
      findings,
      duplicateIds,
    };
  }

  private buildFinding(
    snapshot: Snapshot,
    info: TreeInfo,
    source: SnapshotNode,
    attribute: string,
    raw: string,
    single: boolean,
    scopeNid: string,
    scopeBoundary: ScopeBoundary[],
  ): Finding {
    const seen = new Set<string>();
    const tokens = (single ? [raw.trim()] : raw.split(/[ \t\r\n\f]+/).filter(t => t.length))
      .map((token, index) => {
        const duplicateToken = seen.has(token);
        seen.add(token);
        return this.resolveToken(snapshot, info, token, index, duplicateToken, scopeNid);
      });
    return {
      attribute,
      sourceNid: source.nid,
      sourceTag: source.tag ?? 'unknown',
      sourcePath: pathToNode(snapshot.root, source.nid),
      scopeNid,
      scopeBoundary,
      tokens,
      severity: 'ok',
    };
  }

  private resolveToken(
    snapshot: Snapshot,
    info: TreeInfo,
    token: string,
    index: number,
    duplicateToken: boolean,
    scopeNid: string,
  ): TokenResolution {
    const local = this.indexFor(info, scopeNid).idIndex.get(token) ?? [];
    const targets: ResolvedTarget[] = local.map((node, i) => ({
      nid: node.nid,
      tag: node.tag ?? 'unknown',
      id: token,
      path: pathToNode(snapshot.root, node.nid),
      effective: i === 0,
    }));
    const unreachable: UnreachableMatch[] = [];
    if (local.length === 0) {
      for (const [otherScopeNid, otherScope] of info.scopes) {
        if (otherScopeNid === scopeNid) continue;
        const foreign = this.indexFor(info, otherScopeNid).idIndex.get(token);
        if (!foreign) continue;
        const blockedBy = boundaryBetween(info.scopes.get(scopeNid)!.boundary, otherScope.boundary);
        if (blockedBy) {
          for (const node of foreign) {
            unreachable.push({nid: node.nid, scopeNid: otherScopeNid, id: token, blockedBy, path: pathToNode(snapshot.root, node.nid)});
          }
        }
      }
    }
    const status: TokenStatus = local.length === 0 ? 'missing' : local.length > 1 ? 'ambiguous' : 'ok';
    return {token, index, status, targets, unreachable, duplicateToken: duplicateToken || undefined};
  }
}

/**
 * Describes the first boundary that separates two scopes. Returns null when
 * the scopes are actually the same chain (caller already excludes that).
 */
function boundaryBetween(
  from: ScopeBoundary[],
  to: ScopeBoundary[],
): {kind: 'shadow'; host: string; mode: ShadowMode} | {kind: 'iframe'; iframe: string} | null {
  const depth = Math.min(from.length, to.length);
  for (let i = 0; i < depth; i++) {
    if (boundaryKey(from[i]) !== boundaryKey(to[i])) return describe(to[i]);
  }
  // One chain is a prefix of the other: the first extra hop of the deeper
  // chain is the blocking boundary.
  const next = to.length > from.length ? to[from.length] : from[to.length];
  return next ? describe(next) : null;
}

function boundaryKey(b: ScopeBoundary): string {
  return b.kind === 'shadow' ? `shadow:${b.host}` : `iframe:${b.iframe}`;
}

function describe(b: ScopeBoundary) {
  return b.kind === 'shadow'
    ? {kind: 'shadow' as const, host: b.host, mode: b.mode}
    : {kind: 'iframe' as const, iframe: b.iframe};
}

/** Client/server shared helper: locate a node inside snapshot JSON by nid. */
export function findSnapshotNode(root: SnapshotNode, nid: string): SnapshotNode | null {
  if (root.nid === nid) return root;
  for (const child of root.children ?? []) {
    const hit = findSnapshotNode(child, nid);
    if (hit) return hit;
  }
  if (root.shadow) {
    const hit = findSnapshotNode(root.shadow, nid);
    if (hit) return hit;
  }
  if (root.contentDocument) {
    const hit = findSnapshotNode(root.contentDocument, nid);
    if (hit) return hit;
  }
  return null;
}
