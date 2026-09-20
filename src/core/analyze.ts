import {
  analyzeIdRefs,
  buildScopes,
  scopeInfos,
  type ScopeCacheState,
} from './scope';
import type {AnalysisResult, SnapshotData} from './types';

export interface AnalysisOutput {
  result: AnalysisResult;
  cache: ScopeCacheState;
}

/**
 * Run an IDREF analysis over a captured snapshot.
 *
 * The optional previous cache is keyed by snapshot revision. Only scopes whose
 * owning subtree changed are rebuilt; the returned `stats.invalidatedScopes`
 * makes that granularity observable.
 */
export function analyzeSnapshot(snapshot: SnapshotData, prev?: ScopeCacheState): AnalysisOutput {
  const scoped = buildScopes(snapshot, prev);
  const findings = analyzeIdRefs(scoped);
  let idRefAttributes = 0;
  let elements = 0;
  for (const idx of scoped.indexes.values()) {
    elements += idx.sids.size;
    for (const node of idx.nodes.values()) {
      for (const attr of Object.keys(node.attrs)) {
        if (isIdRefAttr(attr)) idRefAttributes += 1;
      }
    }
  }
  const result: AnalysisResult = {
    revision: snapshot.revision,
    findings,
    scopes: scopeInfos(scoped),
    stats: {
      scopes: scoped.indexes.size,
      elements,
      idRefAttributes,
      indexRebuilds: scoped.cache.rebuilt.length,
      invalidatedScopes: scoped.cache.rebuilt,
    },
  };
  return {result, cache: scoped.cache};
}

function isIdRefAttr(name: string): boolean {
  return [
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
  ].includes(name.toLowerCase());
}
