/**
 * Builds {@link Snapshot} trees from a compact fixture/JSON description and
 * applies mutations while preserving stable node ids.
 *
 * Input node form (any of):
 *   {tag:'div', attrs:{...}, children:[...], shadow:'open'|{mode,children:[...]},
 *    document:{children:[...]}, note:'...', nid:'...'}
 *   'plain text node'
 */
import type {MutationOp, ShadowMode, Snapshot, SnapshotNode} from './types';
import {buildTreeInfo, iterAllNodes} from './traverse';

export type InputNode = InputElement | string;

export interface InputElement {
  tag: string;
  attrs?: Record<string, string>;
  children?: InputNode[];
  /** Shadow root on this host: 'open' | 'closed' | {mode, children}. */
  shadow?: ShadowMode | {mode: ShadowMode; children?: InputNode[]};
  /** Captured iframe content document. */
  document?: {children?: InputNode[]};
  note?: string;
  /** Stable nid override (fixtures may pin ids for readability). */
  nid?: string;
}

export function buildSnapshot(root: InputElement): Snapshot {
  let counter = 0;
  const nextId = () => `n${++counter}`;
  return {root: buildElement(root, nextId), revision: 1};
}

function buildElement(input: InputElement, nextId: () => string): SnapshotNode {
  const node: SnapshotNode = {nid: input.nid ?? nextId(), kind: 'element', tag: input.tag, rev: 1};
  if (input.attrs && Object.keys(input.attrs).length) node.attrs = {...input.attrs};
  if (input.note) node.note = input.note;
  if (input.children?.length) node.children = input.children.map(child => buildChild(child, nextId));
  if (input.shadow) {
    const mode = typeof input.shadow === 'string' ? input.shadow : input.shadow.mode;
    const kids = typeof input.shadow === 'string' ? [] : input.shadow.children ?? [];
    node.shadow = buildScopeRoot('shadow', mode, kids, nextId);
  }
  if (input.document) {
    node.contentDocument = buildScopeRoot('document', undefined, input.document.children ?? [], nextId);
  }
  return node;
}

function buildScopeRoot(
  kind: 'document' | 'shadow',
  mode: ShadowMode | undefined,
  children: InputNode[],
  nextId: () => string,
): SnapshotNode {
  const node: SnapshotNode = {nid: nextId(), kind, rev: 1, children: children.map(c => buildChild(c, nextId))};
  if (mode) node.shadowMode = mode;
  return node;
}

function buildChild(input: InputNode, nextId: () => string): SnapshotNode {
  if (typeof input === 'string') return {nid: nextId(), kind: 'text', data: input, rev: 1};
  return buildElement(input, nextId);
}

/** Applies one mutation, bumping revisions only on nodes actually affected. */
export function applyMutation(snapshot: Snapshot, op: MutationOp): Snapshot {
  snapshot = structuredClone(snapshot);
  snapshot.revision += 1;

  switch (op.type) {
    case 'set-attr': {
      const info = buildTreeInfo(snapshot.root);
      const node = info.nodes.get(op.nid);
      if (!node) throw new Error(`unknown nid: ${op.nid}`);
      const before = node.attrs?.[op.name];
      const attrs = {...(node.attrs ?? {})};
      if (op.value === null) delete attrs[op.name];
      else attrs[op.name] = op.value;
      node.attrs = Object.keys(attrs).length ? attrs : undefined;
      node.rev += 1;
      // Only id edits change the scope's id index; edits to aria-* / class /
      // anything else leave every cached index valid.
      if (op.name === 'id') {
        const after = op.value === null ? undefined : op.value;
        if (before !== after) info.nodes.get(info.scopeOf.get(op.nid)!)!.rev += 1;
      }
      break;
    }
    case 'insert': {
      const info = buildTreeInfo(snapshot.root);
      const parent = info.nodes.get(op.parent);
      if (!parent) throw new Error(`unknown nid: ${op.parent}`);
      if (!parent.children) parent.children = [];
      const used = new Set(Array.from(iterAllNodes(snapshot.root), n => n.nid));
      const at = Math.max(0, Math.min(op.index ?? parent.children.length, parent.children.length));
      parent.children.splice(at, 0, assignFreshIds(op.node, used));
      parent.rev += 1;
      // Structural edit in the parent's own scope: invalidate exactly it.
      // Nested scopes carried by the inserted subtree are brand new (rev 1).
      info.nodes.get(info.scopeOf.get(op.parent)!)!.rev += 1;
      break;
    }
    case 'remove': {
      const info = buildTreeInfo(snapshot.root);
      const scopeNid = info.scopeOf.get(op.nid);
      const found = findContainingList(snapshot.root, op.nid);
      if (!found) throw new Error(`unknown nid: ${op.nid}`);
      found[0].splice(found[1], 1);
      // Invalidate the scope that lost a member; nested scopes of the removed
      // subtree are evicted by the analyzer's cache GC.
      if (scopeNid) {
        info.nodes.get(scopeNid)!.rev += 1;
      }
      break;
    }
    case 'move': {
      const info = buildTreeInfo(snapshot.root);
      const node = info.nodes.get(op.nid);
      const target = info.nodes.get(op.parent);
      if (!node) throw new Error(`unknown nid: ${op.nid}`);
      if (!target) throw new Error(`unknown nid: ${op.parent}`);
      if (op.nid === op.parent) throw new Error('cannot move node into itself');
      for (const descendant of iterAllNodes(node)) {
        if (descendant.nid === op.parent) throw new Error('cannot move node into its own subtree');
      }
      if (target.kind !== 'element' && target.kind !== 'shadow' && target.kind !== 'document') {
        throw new Error(`cannot move into ${target.kind} node`);
      }
      const from = findContainingList(snapshot.root, op.nid);
      if (!from) throw new Error(`unknown nid: ${op.nid}`);
      const oldScope = info.nodes.get(info.scopeOf.get(op.nid)!)!;
      const newScope =
        target.kind === 'element' ? info.nodes.get(info.scopeOf.get(op.parent)!)! : target;
      from[0].splice(from[1], 1);
      if (!target.children) target.children = [];
      const at = Math.max(0, Math.min(op.index ?? target.children.length, target.children.length));
      target.children.splice(at, 0, node);
      // Structural edit: the moved node and exactly the affected scope roots
      // get rev bumps; unrelated scopes keep their cached indexes.
      node.rev += 1;
      if (oldScope === newScope) {
        oldScope.rev += 1;
      } else {
        oldScope.rev += 1;
        newScope.rev += 1;
      }
      break;
    }
  }
  return snapshot;
}

export function applyMutations(snapshot: Snapshot, ops: MutationOp[]): Snapshot {
  return ops.reduce(applyMutation, snapshot);
}

/** Clones an inserted subtree, replacing nids that already exist in the tree. */
function assignFreshIds(node: SnapshotNode, used: Set<string>): SnapshotNode {
  let counter = 0;
  const fresh = () => {
    let candidate: string;
    do candidate = `x${++counter}`;
    while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };
  const walk = (current: SnapshotNode): SnapshotNode => {
    const copy: SnapshotNode = {...current, nid: used.has(current.nid) ? fresh() : current.nid, rev: 1};
    used.add(copy.nid);
    if (copy.children) copy.children = copy.children.map(walk);
    if (copy.shadow) copy.shadow = walk(copy.shadow);
    if (copy.contentDocument) copy.contentDocument = walk(copy.contentDocument);
    return copy;
  };
  return walk(node);
}

/** Finds the child list and position of a nid anywhere in the snapshot. */
export function findContainingList(node: SnapshotNode, nid: string): [SnapshotNode[], number] | null {
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].nid === nid) return [node.children, i];
      const deeper = findContainingList(node.children[i], nid);
      if (deeper) return deeper;
    }
  }
  if (node.shadow) {
    const deeper = findContainingRoot(node.shadow, nid);
    if (deeper) return deeper;
  }
  if (node.contentDocument) {
    const deeper = findContainingRoot(node.contentDocument, nid);
    if (deeper) return deeper;
  }
  return null;
}

function findContainingRoot(root: SnapshotNode, nid: string): [SnapshotNode[], number] | null {
  if (root.children) {
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i].nid === nid) return [root.children, i];
      const deeper = findContainingList(root.children[i], nid);
      if (deeper) return deeper;
    }
  }
  return null;
}
