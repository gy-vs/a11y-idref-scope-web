import {locateByPath} from '../core/scope';
import type {
  AnalysisResult,
  BoundaryKind,
  IdRefFinding,
  LocatedNode,
  SnapshotData,
  VNode,
} from '../core/types';

/**
 * Locate a finding target purely from server-provided stable data.
 *
 * The browser MUST NOT call getElementById / querySelector here: the audited
 * page lives in a captured snapshot (and often behind iframes / closed shadow
 * roots the workbench document cannot see). We replay the stable-id path the
 * server returned against the snapshot instead.
 */
export function locate(
  snapshot: SnapshotData,
  finding: IdRefFinding,
  tokenIndex: number,
): LocatedNode {
  const token = finding.tokens[tokenIndex];
  const sid = token?.sid ?? token?.candidates?.[0] ?? '';
  const path = token?.path ?? finding.sourcePath;
  return locateByPath(snapshot, sid, path, snapshot.revision);
}

export const BOUNDARY_LABEL: Record<BoundaryKind, string> = {
  document: 'document',
  frame: 'iframe',
  'shadow-open': 'open shadow',
  'shadow-closed': 'closed shadow',
};

export function summarizeSeverity(result: AnalysisResult): Record<string, number> {
  const counts = {ok: 0, missing: 0, ambiguous: 0, unreachable: 0};
  for (const f of result.findings) counts[f.severity] += 1;
  return counts;
}

export function nodeLabel(node: VNode): string {
  const id = node.attrs.id ? ` #${node.attrs.id}` : '';
  return `<${node.tag}${id}> [${node.sid}]`;
}
