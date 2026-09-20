import {describe, expect, it} from 'vitest';
import {applyMutation, buildSnapshot} from './builder';
import {ScopeAnalyzer, findSnapshotNode} from './resolver';
import type {Finding} from './resolver';
import {demoPage} from './fixtures';

function analyze(snapshot = demoPage()) {
  const analyzer = new ScopeAnalyzer();
  return {analyzer, result: analyzer.analyze(snapshot), snapshot};
}

function findingFor(result: ReturnType<ScopeAnalyzer['analyze']>, sourceNid: string, attr: string): Finding {
  const found = result.findings.find(f => f.sourceNid === sourceNid && f.attribute === attr);
  if (!found) throw new Error(`no finding for ${sourceNid}@${attr}`);
  return found;
}

describe('scoped IDREF resolution', () => {
  it('builds independent scopes for document, shadow roots and iframe documents', () => {
    const {result} = analyze();
    // top document + open shadow + closed shadow + iframe document
    expect(result.summary.scopes).toBe(4);
    expect(result.summary.shadowScopes).toBe(2);
    expect(result.summary.frameScopes).toBe(1);
  });

  it('reports duplicate ids inside one scope as ambiguity, first match effective', () => {
    const {result} = analyze();
    const dup = result.duplicateIds.find(d => d.id === 'dup-title' && d.scopeBoundary.length === 0);
    expect(dup).toBeTruthy();
    expect(dup!.nodes.map(n => n.nid)).toEqual(['dup-a', 'dup-b']);

    const btn = findingFor(result, 'multi-btn', 'aria-labelledby');
    const dupToken = btn.tokens.find(t => t.token === 'dup-title')!;
    expect(dupToken.status).toBe('ambiguous');
    expect(dupToken.targets).toHaveLength(2);
    expect(dupToken.targets[0].nid).toBe('dup-a');
    expect(dupToken.targets[0].effective).toBe(true);
    expect(dupToken.targets[1].effective).toBe(false);
    // Targets carry stable ids and boundary-aware paths.
    expect(dupToken.targets[0].path.at(-1)).toContain('dup-title');
  });

  it('resolves multiple tokens independently and flags missing ones', () => {
    const {result} = analyze();
    const btn = findingFor(result, 'multi-btn', 'aria-labelledby');
    expect(btn.tokens.map(t => [t.token, t.status])).toEqual([
      ['title', 'ok'],
      ['dup-title', 'ambiguous'],
      ['gone-token', 'missing'],
    ]);
    expect(btn.severity).toBe('mixed');

    const err = findingFor(result, 'err-input', 'aria-errormessage');
    expect(err.tokens).toHaveLength(1);
    expect(err.tokens[0].status).toBe('missing');

    // Token-level counts add up across mixed severities.
    expect(result.summary.ok + result.summary.ambiguous + result.summary.missing).toBe(result.summary.references);
    expect(result.summary.ambiguous).toBeGreaterThan(0);
  });

  it('never resolves across the open shadow boundary in either direction', () => {
    const {result} = analyze();
    // Inside the open shadow root, #title (light DOM) is unreachable.
    const inner = findingFor(result, 'open-shadow-btn', 'aria-labelledby');
    expect(inner.tokens[0].status).toBe('missing');
    expect(inner.tokens[0].targets).toHaveLength(0);
    expect(inner.tokens[0].unreachable.some(u => u.nid === 'page-title')).toBe(true);
    expect(inner.tokens[0].unreachable[0].blockedBy).toMatchObject({kind: 'shadow', host: 'open-host', mode: 'open'});

    // On the host (top document scope), the in-shadow id is unreachable.
    const host = findingFor(result, 'open-host', 'aria-labelledby');
    expect(host.tokens[0].status).toBe('missing');
    expect(host.tokens[0].unreachable.some(u => u.nid === 'inside-open-el')).toBe(true);
  });

  it('resolves ids inside a closed shadow root snapshot', () => {
    const {result} = analyze();
    const btn = findingFor(result, 'closed-btn', 'aria-describedby');
    expect(btn.tokens[0].status).toBe('ok');
    expect(btn.tokens[0].targets[0].nid).toBe('closed-heading');
    expect(btn.scopeBoundary).toContainEqual({kind: 'shadow', host: 'closed-host', mode: 'closed'});
  });

  it('keeps iframe document ids separate from the parent document', () => {
    const {result} = analyze();
    const frameBtn = findingFor(result, 'frame-btn', 'aria-labelledby');
    expect(frameBtn.tokens[0].status).toBe('ok');
    expect(frameBtn.tokens[0].targets[0].nid).toBe('frame-title');
    expect(frameBtn.scopeBoundary).toContainEqual({kind: 'iframe', iframe: 'frame'});

    // Duplicate id inside the frame is scoped to the frame only.
    const frameDup = result.duplicateIds.find(d => d.id === 'dup-title' && d.scopeBoundary.some(b => b.kind === 'iframe'));
    expect(frameDup!.nodes.map(n => n.nid)).toEqual(['frame-dup-a', 'frame-dup-b']);
    // And it is a separate group from the top-document duplicates.
    expect(result.duplicateIds.filter(d => d.id === 'dup-title')).toHaveLength(2);

    // Top-document references must never resolve to frame nodes: the frame
    // holds an id "title" too, but the top doc has its own. Check a missing
    // top-doc token does not silently accept the frame's id when the only
    // same-id node existed across the boundary.
    const btn = findingFor(result, 'multi-btn', 'aria-labelledby');
    const gone = btn.tokens.find(t => t.token === 'gone-token')!;
    expect(gone.unreachable).toEqual([]);
  });

  it('reports same-id node across an iframe as an unreachable alternative', () => {
    const snap = buildSnapshot({
      tag: 'html',
      children: [
        {tag: 'body', children: [
          {tag: 'button', nid: 'b', attrs: {'aria-labelledby': 'only-in-frame'}},
          {tag: 'iframe', nid: 'f', document: {children: [
            {tag: 'html', children: [{tag: 'body', children: [
              {tag: 'h1', nid: 'h', attrs: {id: 'only-in-frame'}, children: ['x']},
            ]}]},
          ]}},
        ]},
      ],
    });
    const {result} = analyze(snap);
    const f = result.findings.find(f => f.sourceNid === 'b')!;
    expect(f.tokens[0].status).toBe('missing');
    expect(f.tokens[0].unreachable[0]).toMatchObject({nid: 'h', blockedBy: {kind: 'iframe', iframe: 'f'}});
  });
});

describe('scope index cache', () => {
  it('rebuilds all indexes once, then reuses them on an unchanged re-analysis', () => {
    const analyzer = new ScopeAnalyzer();
    const snap = demoPage();
    const first = analyzer.analyze(snap);
    expect(new Set(analyzer.stats.rebuilt).size).toBe(first.summary.scopes);
    expect(analyzer.stats.reused).toEqual([]);
    analyzer.analyze(snap);
    expect(analyzer.stats.rebuilt).toEqual([]);
    expect(analyzer.stats.reused.length).toBe(first.summary.scopes);
  });

  it('does not rebuild any index for an unrelated attribute change', () => {
    const analyzer = new ScopeAnalyzer();
    let snap = demoPage();
    analyzer.analyze(snap);
    snap = applyMutation(snap, {type: 'set-attr', nid: 'page-title', name: 'class', value: 'highlighted'});
    analyzer.analyze(snap);
    expect(analyzer.stats.rebuilt, 'no scope index should be rebuilt').toEqual([]);
  });

  it('rebuilds only the owning scope when an id attribute changes', () => {
    const analyzer = new ScopeAnalyzer();
    let snap = demoPage();
    analyzer.analyze(snap);
    snap = applyMutation(snap, {type: 'set-attr', nid: 'closed-heading', name: 'id', value: 'renamed-h'});
    analyzer.analyze(snap);
    // Only the closed shadow scope is invalidated.
    expect(analyzer.stats.rebuilt).toHaveLength(1);
    const rebuiltNode = findSnapshotNode(snap.root, analyzer.stats.rebuilt[0])!;
    expect(rebuiltNode.kind).toBe('shadow');
    expect(rebuiltNode.shadowMode).toBe('closed');
    // The rename actually took effect: the inner reference is now missing.
    const f = analyzer.analyze(snap).findings.find(x => x.sourceNid === 'closed-btn')!;
    expect(f.tokens[0].status).toBe('missing');
  });

  it('invalidates exactly the old and new scopes when a node moves across a boundary', () => {
    const analyzer = new ScopeAnalyzer();
    let snap = demoPage();
    analyzer.analyze(snap);
    // Move the light-DOM title into the open shadow root.
    snap = applyMutation(snap, {type: 'move', nid: 'page-title', parent: 'open-host'});
    // Wait: children of a host element are light DOM. Move into the shadow
    // root itself (scope root) to cross the boundary.
    analyzer.analyze(snap);
    // page-title moved within the top-document scope (host is light DOM):
    // only that scope is rebuilt.
    expect(analyzer.stats.rebuilt).toHaveLength(1);

    const openShadowNid = findSnapshotNode(snap.root, 'open-host')!.shadow!.nid;
    snap = applyMutation(snap, {type: 'move', nid: 'page-title', parent: openShadowNid});
    analyzer.analyze(snap);
    expect(new Set(analyzer.stats.rebuilt).size).toBe(2);
    // After crossing, the shadow button resolves and the top-doc button loses its title.
    const result = analyzer.analyze(snap);
    const shadowBtn = result.findings.find(f => f.sourceNid === 'open-shadow-btn')!;
    expect(shadowBtn.tokens[0].status).toBe('ok');
    const multi = result.findings.find(f => f.sourceNid === 'multi-btn')!;
    expect(multi.tokens.find(t => t.token === 'title')!.status).toBe('missing');
  });

  it('invalidates one scope for an in-scope move and keeps the moved node id stable', () => {
    const analyzer = new ScopeAnalyzer();
    let snap = demoPage();
    analyzer.analyze(snap);
    snap = applyMutation(snap, {type: 'move', nid: 'dup-a', parent: 'doc-body', index: 0});
    analyzer.analyze(snap);
    expect(analyzer.stats.rebuilt).toHaveLength(1);
    // Stable nid survives the move.
    expect(findSnapshotNode(snap.root, 'dup-a')).toBeTruthy();
  });

  it('evicts indexes of scopes removed from the snapshot', () => {
    const analyzer = new ScopeAnalyzer();
    let snap = demoPage();
    analyzer.analyze(snap);
    expect(analyzer.stats.rebuilt.length).toBe(4);
    snap = applyMutation(snap, {type: 'remove', nid: 'frame'});
    const result = analyzer.analyze(snap);
    expect(result.summary.scopes).toBe(3);
    expect(result.summary.frameScopes).toBe(0);
    // Re-run: removed scopes must not come back as stale cache hits.
    analyzer.analyze(snap);
    expect(analyzer.stats.reused.length).toBe(3);
  });
});

describe('snapshot-only node lookup', () => {
  it('finds nodes by stable nid inside snapshot JSON, including shadow/iframe', () => {
    const {snapshot} = analyze();
    expect(findSnapshotNode(snapshot.root, 'closed-heading')!.tag).toBe('h2');
    expect(findSnapshotNode(snapshot.root, 'frame-title')!.tag).toBe('h1');
    expect(findSnapshotNode(snapshot.root, 'nope')).toBeNull();
  });
});
