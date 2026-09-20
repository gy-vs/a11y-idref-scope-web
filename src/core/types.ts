/**
 * Serialized DOM snapshot model.
 *
 * The audit engine never touches the live (workbench) document: pages,
 * iframe content documents and shadow roots (including closed ones, which
 * are only observable through a captured accessibility snapshot) are all
 * represented as plain JSON nodes addressed by stable node ids (`nid`).
 */

export type ShadowMode = 'open' | 'closed';

export type NodeKind = 'document' | 'element' | 'shadow' | 'text';

export interface SnapshotNode {
  /** Stable identity. Survives attribute edits and moves between subtrees. */
  nid: string;
  kind: NodeKind;
  /** Lower-case tag name for element nodes (e.g. 'div', 'slot', 'iframe'). */
  tag?: string;
  attrs?: Record<string, string>;
  /** Light / regular DOM children (elements and text). */
  children?: SnapshotNode[];
  /** Present on a shadow host element. */
  shadow?: SnapshotNode | null;
  /** Shadow root mode ('open' / 'closed'). Meaningful on kind 'shadow'. */
  shadowMode?: ShadowMode;
  /** Present on an iframe element; the captured document inside it. */
  contentDocument?: SnapshotNode | null;
  /** Text data for kind 'text'. */
  data?: string;
  /**
   * Node revision. Bumped whenever the node is touched by a mutation
   * (attribute change, move in/out of its parent subtree). Scope index
   * caches derive their signatures from scope-relevant fields only, so an
   * unrelated rev bump never forces an index rebuild.
   */
  rev: number;
  /** Human-readable annotation used in the workbench UI. */
  note?: string;
}

export interface Snapshot {
  root: SnapshotNode;
  revision: number;
}

/** Mutation operations supported by the workbench / test harness. */
export type MutationOp =
  | {type: 'set-attr'; nid: string; name: string; value: string | null}
  | {type: 'move'; nid: string; parent: string; index?: number}
  | {type: 'insert'; parent: string; node: SnapshotNode; index?: number}
  | {type: 'remove'; nid: string};
