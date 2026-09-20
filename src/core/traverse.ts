/**
 * Structural traversal over a snapshot: node lookup, parent links and
 * ARIA scope boundaries.
 *
 * A "scope root" is a node that owns an independent id namespace:
 *   - the top-level document
 *   - every shadow root (open or closed — closed roots still exist in the
 *     captured snapshot and behave identically for IDREF resolution)
 *   - every iframe content document
 */
import type {SnapshotNode} from './types';

export function isScopeRoot(node: SnapshotNode): boolean {
  return node.kind === 'document' || node.kind === 'shadow';
}

export function* iterAllNodes(node: SnapshotNode): Generator<SnapshotNode> {
  yield node;
  for (const child of node.children ?? []) yield* iterAllNodes(child);
  if (node.shadow) yield* iterAllNodes(node.shadow);
  if (node.contentDocument) yield* iterAllNodes(node.contentDocument);
}

export interface TreeInfo {
  nodes: Map<string, SnapshotNode>;
  /** Parent node nid for every non-root node. */
  parent: Map<string, string>;
  /** Scope-root nid that directly contains the nid's namespace. */
  scopeOf: Map<string, string>;
  /** Scope roots in tree order. */
  scopes: Map<string, ScopeInfo>;
}

export interface ScopeInfo {
  root: SnapshotNode;
  /**
   * Inward traversal path from the top document:
   * document | host/shadow | iframe/document pairs.
   */
  boundary: ScopeBoundary[];
  /** Shadow mode if this scope is a shadow root. */
  shadowMode?: 'open' | 'closed';
}

export type ScopeBoundary =
  | {kind: 'shadow'; host: string; mode: 'open' | 'closed'}
  | {kind: 'iframe'; iframe: string};

export function buildTreeInfo(root: SnapshotNode): TreeInfo {
  const nodes = new Map<string, SnapshotNode>();
  const parent = new Map<string, string>();
  const scopeOf = new Map<string, string>();
  const scopes = new Map<string, ScopeInfo>();

  const walk = (node: SnapshotNode, parentNid: string | null, scopeNid: string, boundary: ScopeBoundary[]) => {
    if (nodes.has(node.nid)) throw new Error(`duplicate nid in snapshot: ${node.nid}`);
    nodes.set(node.nid, node);
    if (parentNid) parent.set(node.nid, parentNid);
    scopeOf.set(node.nid, scopeNid);

    if (node.shadow) {
      const childBoundary: ScopeBoundary[] = [...boundary, {kind: 'shadow', host: node.nid, mode: node.shadow.shadowMode ?? 'open'}];
      const shadowScope: ScopeInfo = {root: node.shadow, boundary: childBoundary, shadowMode: node.shadow.shadowMode};
      scopes.set(node.shadow.nid, shadowScope);
      walk(node.shadow, node.nid, node.shadow.nid, childBoundary);
    }
    if (node.contentDocument) {
      const childBoundary: ScopeBoundary[] = [...boundary, {kind: 'iframe', iframe: node.nid}];
      const docScope: ScopeInfo = {root: node.contentDocument, boundary: childBoundary};
      scopes.set(node.contentDocument.nid, docScope);
      walk(node.contentDocument, node.nid, node.contentDocument.nid, childBoundary);
    }
    for (const child of node.children ?? []) walk(child, node.nid, scopeNid, boundary);
  };

  scopes.set(root.nid, {root, boundary: []});
  walk(root, null, root.nid, []);
  return {nodes, parent, scopeOf, scopes};
}

/** Stable, human-readable path from the snapshot root to a node. */
export function pathToNode(root: SnapshotNode, targetNid: string): string[] {
  const segments: string[] = [];
  const visit = (node: SnapshotNode, prefix: string[]): boolean => {
    let label: string;
    if (node.kind === 'document') label = '#document';
    else if (node.kind === 'shadow') label = `#shadow-root(${node.shadowMode ?? 'open'})`;
    else if (node.kind === 'text') label = '#text';
    else label = describeElement(node);
    const here = [...prefix, label];
    if (node.nid === targetNid) {
      segments.push(...here);
      return true;
    }
    for (const child of node.children ?? []) if (visit(child, here)) return true;
    if (node.shadow && visit(node.shadow, here)) return true;
    if (node.contentDocument && visit(node.contentDocument, here)) return true;
    return false;
  };
  visit(root, []);
  return segments;
}

function describeElement(node: SnapshotNode): string {
  const parts = [node.tag ?? 'unknown'];
  if (node.attrs?.id) parts.push(`#${node.attrs.id}`);
  const cls = node.attrs?.class;
  if (cls) parts.push(`.${cls.trim().split(/\s+/).join('.')}`);
  return parts.join('');
}
