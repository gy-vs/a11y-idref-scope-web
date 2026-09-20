import type {SnapshotData, VDocument, VNode, VShadow} from './types';

let seq = 0;
/** Stable id generator; stable across revisions because it derives from the
 * explicit key supplied by the caller (falling back to a monotonic counter). */
export function sid(key?: string): string {
  return key ?? `n${(seq += 1)}`;
}

export function el(
  key: string,
  tag: string,
  attrs: Record<string, string> = {},
  children: VNode[] = [],
): VNode {
  return {sid: key, tag, attrs, children};
}

export function attachShadow(host: VNode, mode: 'open' | 'closed', scopeKey: string, children: VNode[]): VShadow {
  const shadow: VShadow = {scopeKey, hostSid: host.sid, mode, children};
  host.shadow = shadow;
  return shadow;
}

export function document(scopeKey: string, children: VNode[], extra: Partial<VDocument> = {}): VDocument {
  return {scopeKey, kind: 'top', children, ...extra};
}

export function frame(scopeKey: string, hostSid: string, children: VNode[], label?: string): VDocument {
  return {scopeKey, kind: 'iframe', hostSid, children, label};
}

export function snapshot(documents: VDocument[], revision = 1): SnapshotData {
  return {documents, revision};
}

/** Return a structurally cloned snapshot with a bumped revision. */
export function revise(data: SnapshotData, bump = 1): SnapshotData {
  return {
    revision: data.revision + bump,
    documents: data.documents.map(cloneDocument),
  };
}

function cloneDocument(doc: VDocument): VDocument {
  return {...doc, children: doc.children.map(cloneNode)};
}

function cloneNode(node: VNode): VNode {
  return {
    ...node,
    attrs: {...node.attrs},
    children: node.children.map(cloneNode),
    shadow: node.shadow ? {...node.shadow, children: node.shadow.children.map(cloneNode)} : undefined,
  };
}

// ---------------------------------------------------------------------------
// Mutation helpers (operate on a cloned snapshot and bump the revision).
// Each returns a new snapshot; callers pass the previous analysis cache to
// observe scoped invalidation.
// ---------------------------------------------------------------------------

export function withAttr(data: SnapshotData, targetSid: string, name: string, value: string): SnapshotData {
  const next = revise(data);
  const node = findNode(next, targetSid);
  if (!node) throw new Error(`sid not found: ${targetSid}`);
  node.attrs[name] = value;
  return next;
}

export function moved(data: SnapshotData, movedSid: string, newParentSid: string): SnapshotData {
  const next = revise(data);
  const removed = detach(next, movedSid);
  if (!removed) throw new Error(`sid not found: ${movedSid}`);
  const parent = findNode(next, newParentSid);
  if (!parent) throw new Error(`sid not found: ${newParentSid}`);
  parent.children.push(removed);
  return next;
}

/** Move a node across a boundary into a specific target scope (frame/shadow). */
export function movedIntoScope(data: SnapshotData, movedSid: string, targetScopeKey: string): SnapshotData {
  const next = revise(data);
  const removed = detach(next, movedSid);
  if (!removed) throw new Error(`sid not found: ${movedSid}`);
  const roots = scopeRoots(next, targetScopeKey);
  if (!roots) throw new Error(`scope not found: ${targetScopeKey}`);
  roots.push(removed);
  return next;
}

function scopeRoots(data: SnapshotData, scopeKey: string): VNode[] | undefined {
  for (const doc of data.documents) {
    if (doc.scopeKey === scopeKey) return doc.children;
    const shadow = findShadow(doc.children, scopeKey);
    if (shadow) return shadow.children;
  }
  return undefined;
}

function findShadow(nodes: VNode[], scopeKey: string): VShadow | undefined {
  for (const n of nodes) {
    if (n.shadow) {
      if (n.shadow.scopeKey === scopeKey) return n.shadow;
      const deep = findShadow(n.shadow.children, scopeKey);
      if (deep) return deep;
    }
    const deep = findShadow(n.children, scopeKey);
    if (deep) return deep;
  }
  return undefined;
}

export function findNode(data: SnapshotData, target: string): VNode | undefined {
  for (const doc of data.documents) {
    const hit = findIn(doc.children, target);
    if (hit) return hit;
  }
}

function findIn(nodes: VNode[], target: string): VNode | undefined {
  for (const n of nodes) {
    if (n.sid === target) return n;
    const light = findIn(n.children, target);
    if (light) return light;
    if (n.shadow) {
      const dark = findIn(n.shadow.children, target);
      if (dark) return dark;
    }
  }
}

function detach(data: SnapshotData, target: string): VNode | undefined {
  for (const doc of data.documents) {
    const hit = detachFrom(doc.children, target);
    if (hit) return hit;
  }
}

function detachFrom(nodes: VNode[], target: string): VNode | undefined {
  const index = nodes.findIndex((n) => n.sid === target);
  if (index >= 0) {
    const [removed] = nodes.splice(index, 1);
    return removed;
  }
  for (const n of nodes) {
    const light = detachFrom(n.children, target);
    if (light) return light;
    if (n.shadow) {
      const dark = detachFrom(n.shadow.children, target);
      if (dark) return dark;
    }
  }
}
