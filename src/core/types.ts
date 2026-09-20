// ---------------------------------------------------------------------------
// Snapshot model
//
// A snapshot is the workbench's *captured* view of an audited document. It is
// plain serializable data so the server can produce it and the browser can
// consume it without ever touching the live workbench DOM.
//
// Reachability boundaries are first class:
//   - A VDocument is one TreeScope per frame (the top document and every
//     same-document iframe the crawler entered).
//   - A VShadow is one TreeScope per shadow root (open or closed).
//   - A VNode belongs to exactly one scope (its nearest enclosing document or
//     shadow root). ARIA IDREF resolution is legal ONLY inside that scope.
// ---------------------------------------------------------------------------

export type BoundaryKind = 'document' | 'frame' | 'shadow-open' | 'shadow-closed';

export interface VShadow {
  /** Scope key of this shadow root. */
  scopeKey: string;
  /** Stable id of the host VNode that owns this shadow root. */
  hostSid: string;
  mode: 'open' | 'closed';
  /** Children that live in the shadow tree. */
  children: VNode[];
}

export interface VDocument {
  /** Scope key. The top document is always '#document'. */
  scopeKey: string;
  kind: 'top' | 'iframe';
  /** For iframe documents: stable id of the <iframe> host element. */
  hostSid?: string;
  /** Human readable frame label (src/srcdoc title) for diagnostics. */
  label?: string;
  children: VNode[];
}

export interface VNode {
  /** Stable identifier, independent of id attributes and tree position. */
  sid: string;
  tag: string;
  attrs: Record<string, string>;
  children: VNode[];
  /** Element-attached shadow root (at most one per host). */
  shadow?: VShadow;
}

export interface SnapshotData {
  documents: VDocument[];
  /** Monotonic snapshot revision; bumped on every mutation. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Scope descriptors (computed from a snapshot)
// ---------------------------------------------------------------------------

export interface ScopeInfo {
  scopeKey: string;
  kind: BoundaryKind;
  /** Scope key of the enclosing scope, or undefined for the top document. */
  parentScopeKey?: string;
  /** Host element sid for frame/shadow scopes. */
  hostSid?: string;
  mode?: 'open' | 'closed';
  label?: string;
}

// ---------------------------------------------------------------------------
// Resolution results
// ---------------------------------------------------------------------------

/** Why a token could not be bound to an in-scope element. */
export type TokenStatus =
  | 'resolved'
  | 'missing' // no element with this id anywhere reachable by inspection
  | 'ambiguous' // several elements with this id in the SAME scope
  | 'cross-scope' // id exists, but only behind a boundary the IDREF cannot cross
  | 'empty'; // the token slot is blank

export interface ResolveStep {
  /** Document / shadow boundary traversed to continue the path. */
  boundary?: BoundaryKind;
  /** Host element crossed at a boundary. */
  hostSid?: string;
  /** Scope entered by the step. */
  scopeKey?: string;
  /** A regular element on the path inside a scope. */
  sid?: string;
}

export interface ScopeCandidate {
  scopeKey: string;
  kind: BoundaryKind;
  /** First (in tree order) matching element in that other scope. */
  sid: string;
}

export interface ResolvedToken {
  /** Token as written in the IDREF list (blank slots become ''). */
  token: string;
  status: TokenStatus;
  /** Resolved target in the same scope. */
  sid?: string;
  /** Targets when the same id repeats within one scope (status: ambiguous). */
  candidates?: string[];
  /** Matching elements that live behind an unreachable boundary. */
  blockedBy?: ScopeCandidate[];
  /** Stable-id resolution path from the top document to the target. */
  path?: ResolveStep[];
}

export type FindingSeverity = 'ok' | 'missing' | 'ambiguous' | 'unreachable';

export interface IdRefFinding {
  /** Stable id of the element carrying the idref attribute. */
  sourceSid: string;
  attribute: string;
  /** Whether the attribute accepts a token list (aria-labelledby etc.). */
  multi: boolean;
  severity: FindingSeverity;
  /** Path from the top document down to the source element. */
  sourcePath: ResolveStep[];
  tokens: ResolvedToken[];
}

export interface AnalysisResult {
  revision: number;
  findings: IdRefFinding[];
  scopes: ScopeInfo[];
  stats: {
    scopes: number;
    elements: number;
    idRefAttributes: number;
    /** Id indexes rebuilt since the previous analysis call. */
    indexRebuilds: number;
    /** Scope keys whose indexes were rebuilt since the previous call. */
    invalidatedScopes: string[];
  };
}

/** A target handed to the frontend: locate the snapshot node, never the DOM. */
export interface LocatedNode {
  found: boolean;
  sid: string;
  scopeKey?: string;
  /** Stable path replay, purely within the snapshot. */
  path: ResolveStep[];
  /** Snapshot revision the result was produced against. */
  revision: number;
  /** Closed shadows cannot be revealed in a live browser, even from a snapshot replay. */
  liveRevealable: boolean;
  boundaryKinds: BoundaryKind[];
}
