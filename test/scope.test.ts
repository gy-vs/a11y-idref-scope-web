import {describe, expect, it} from 'vitest';
import {analyzeSnapshot} from '../src/core/analyze';
import {locateByPath} from '../src/core/scope';
import {attachShadow, el, frame, moved, movedIntoScope, revise, snapshot, withAttr} from '../src/core/builder';
import type {IdRefFinding, SnapshotData} from '../src/core/types';

function findingFor(data: SnapshotData, sourceSid: string, attribute = 'aria-labelledby') {
  const {result} = analyzeSnapshot(data);
  const f = result.findings.find((x) => x.sourceSid === sourceSid && x.attribute === attribute);
  if (!f) throw new Error(`no finding for ${sourceSid}/${attribute}`);
  return {f, result};
}

describe('scope model basics', () => {
  it('resolves a single in-scope target with a stable-id path', () => {
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('lbl', 'span', {id: 'name'}, []),
        el('inp', 'input', {'aria-labelledby': 'name'}, []),
      ]},
    ]);
    const {f} = findingFor(data, 'inp');
    expect(f.severity).toBe('ok');
    expect(f.tokens[0]).toMatchObject({token: 'name', status: 'resolved', sid: 'lbl'});
    expect(f.tokens[0].path?.map((s) => s.sid)).toEqual(['lbl']);
  });

  it('splits a multi-token attribute and resolves each independently', () => {
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('a', 'span', {id: 'a'}, []),
        el('b', 'span', {id: 'b'}, []),
        el('inp', 'input', {'aria-labelledby': 'a b'}, []),
      ]},
    ]);
    const {f} = findingFor(data, 'inp');
    expect(f.multi).toBe(true);
    expect(f.tokens.map((t) => [t.token, t.status, t.sid])).toEqual([
      ['a', 'resolved', 'a'],
      ['b', 'resolved', 'b'],
    ]);
  });

  it('flags a missing target and does not fabricate a path', () => {
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('inp', 'input', {'aria-labelledby': 'ghost'}, []),
      ]},
    ]);
    const {f} = findingFor(data, 'inp');
    expect(f.tokens[0]).toMatchObject({token: 'ghost', status: 'missing'});
    expect(f.tokens[0].path).toBeUndefined();
    expect(f.severity).toBe('missing');
  });

  it('flags an empty token slot in a token list', () => {
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('inp', 'input', {'aria-labelledby': '   '}, []),
      ]},
    ]);
    const {f} = findingFor(data, 'inp');
    expect(f.tokens[0].status).toBe('empty');
  });

  it('reports ambiguity for duplicate ids in the same scope with all candidates', () => {
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('one', 'h1', {id: 'dup'}, []),
        el('two', 'h2', {id: 'dup'}, []),
        el('inp', 'input', {'aria-labelledby': 'dup'}, []),
      ]},
    ]);
    const {f} = findingFor(data, 'inp');
    expect(f.tokens[0].status).toBe('ambiguous');
    expect(f.tokens[0].candidates).toEqual(['one', 'two']);
    expect(f.severity).toBe('ambiguous');
  });
});

describe('shadow boundaries', () => {
  function openShadowFixture() {
    const host = el('host', 'my-card', {});
    const inner = el('inner-label', 'span', {id: 'ttl'}, []);
    const innerRef = el('inner-btn', 'button', {'aria-labelledby': 'ttl'}, []);
    attachShadow(host, 'open', 'shadow:host', [inner, innerRef]);
    const outerRef = el('outer-btn', 'button', {'aria-labelledby': 'ttl'}, []);
    const outerLabel = el('outer-label', 'span', {id: 'ttl'}, []);
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [host, outerLabel, outerRef]},
    ]);
    return {data, host};
  }

  it('resolves an id inside an open shadow root only within that scope', () => {
    const {data} = openShadowFixture();
    const inner = findingFor(data, 'inner-btn').f;
    expect(inner.tokens[0]).toMatchObject({status: 'resolved', sid: 'inner-label'});
  });

  it('does not let a light-DOM reference cross into a shadow scope', () => {
    const {data} = openShadowFixture();
    // outer has its OWN in-scope 'ttl' so it resolves to that, never the shadow
    const outer = findingFor(data, 'outer-btn').f;
    expect(outer.tokens[0]).toMatchObject({status: 'resolved', sid: 'outer-label'});
  });

  it('reports cross-scope when the only match is inside a shadow root', () => {
    const host = el('host', 'my-card', {});
    attachShadow(host, 'open', 'shadow:host', [el('secret', 'span', {id: 'secret'}, [])]);
    const probe = el('probe', 'button', {'aria-labelledby': 'secret'}, []);
    const data = snapshot([{scopeKey: '#document', kind: 'top', children: [host, probe]}]);
    const {f} = findingFor(data, 'probe');
    expect(f.tokens[0].status).toBe('cross-scope');
    expect(f.tokens[0].blockedBy?.[0]).toMatchObject({scopeKey: 'shadow:host', sid: 'secret'});
    expect(f.severity).toBe('unreachable');
  });

  it('distinguishes open and closed shadow roots in scope metadata and paths', () => {
    const openHost = el('ohost', 'x-a', {});
    attachShadow(openHost, 'open', 'shadow:open', [el('ol', 'span', {id: 'om'}, [])]);
    const closedHost = el('chost', 'x-b', {});
    attachShadow(closedHost, 'closed', 'shadow:closed', [
      el('cm', 'span', {id: 'cm'}, []),
      el('cb', 'button', {'aria-labelledby': 'cm'}, []),
    ]);
    const data = snapshot([{scopeKey: '#document', kind: 'top', children: [openHost, closedHost]}]);
    const {result} = analyzeSnapshot(data);
    const kinds = Object.fromEntries(result.scopes.map((s) => [s.scopeKey, s.kind]));
    expect(kinds['shadow:open']).toBe('shadow-open');
    expect(kinds['shadow:closed']).toBe('shadow-closed');

    const btn = result.findings.find((x) => x.sourceSid === 'cb')!;
    const path = btn.tokens[0].path!;
    // Path crosses the closed boundary explicitly and records the host sid.
    const boundary = path.find((s) => s.boundary === 'shadow-closed');
    expect(boundary).toMatchObject({hostSid: 'chost', scopeKey: 'shadow:closed'});
  });

  it('same id duplicated across separate shadow scopes is unambiguous per source', () => {
    const h1 = el('h1', 'x-a', {});
    attachShadow(h1, 'open', 'shadow:a', [el('a1', 'span', {id: 'same'}, [])]);
    const h2 = el('h2', 'x-b', {});
    attachShadow(h2, 'open', 'shadow:b', [
      el('b1', 'span', {id: 'same'}, []),
      el('b2', 'button', {'aria-labelledby': 'same'}, []),
    ]);
    const data = snapshot([{scopeKey: '#document', kind: 'top', children: [h1, h2]}]);
    const {f} = findingFor(data, 'b2');
    expect(f.tokens[0]).toMatchObject({status: 'resolved', sid: 'b1'});
  });
});

describe('iframe boundaries', () => {
  function frameFixture() {
    const iframe = el('frame-el', 'iframe', {});
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('top-label', 'span', {id: 'ttl'}, []),
        el('top-btn', 'button', {'aria-labelledby': 'ttl'}, []),
        iframe,
      ]},
      frame('frame:one', 'frame-el', [
        el('frame-label', 'span', {id: 'ttl'}, []),
        el('frame-btn', 'button', {'aria-labelledby': 'ttl'}, []),
      ]),
    ]);
    return data;
  }

  it('keeps frame and document id spaces separate', () => {
    const data = frameFixture();
    expect(findingFor(data, 'top-btn').f.tokens[0].sid).toBe('top-label');
    expect(findingFor(data, 'frame-btn').f.tokens[0].sid).toBe('frame-label');
  });

  it('builds a stable path that crosses the iframe boundary', () => {
    const data = frameFixture();
    const path = findingFor(data, 'frame-btn').f.tokens[0].path!;
    const edge = path.find((s) => s.boundary === 'frame');
    expect(edge).toMatchObject({hostSid: 'frame-el', scopeKey: 'frame:one'});
    // target element appears after the crossing
    expect(path.map((s) => s.sid)).toEqual(['frame-el', 'frame-label']);
  });

  it('reports cross-scope instead of leaking the frame id to the top document', () => {
    const iframe = el('frame-el', 'iframe', {});
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [
        el('probe', 'button', {'aria-labelledby': 'only-in-frame'}, []),
        iframe,
      ]},
      frame('frame:one', 'frame-el', [el('deep', 'span', {id: 'only-in-frame'}, [])]),
    ]);
    const {f} = findingFor(data, 'probe');
    expect(f.tokens[0].status).toBe('cross-scope');
    expect(f.tokens[0].blockedBy).toEqual([
      {scopeKey: 'frame:one', kind: 'frame', sid: 'deep'},
    ]);
  });

  it('resolves through a shadow nested inside an iframe', () => {
    const iframe = el('frame-el', 'iframe', {});
    const host = el('nested-host', 'x-z', {});
    attachShadow(host, 'open', 'shadow:nested', [
      el('nested-label', 'span', {id: 'z'}, []),
      el('nested-btn', 'button', {'aria-labelledby': 'z'}, []),
    ]);
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [iframe]},
      frame('frame:one', 'frame-el', [host]),
    ]);
    const {f} = findingFor(data, 'nested-btn');
    expect(f.tokens[0].sid).toBe('nested-label');
    const kinds = f.tokens[0].path!.map((s) => s.boundary).filter(Boolean);
    expect(kinds).toEqual(['frame', 'shadow-open']);
  });
});

describe('frontend path replay on the snapshot', () => {
  it('replays a cross-frame path and never consults the workbench DOM', () => {
    const data = frameFixtureLike();
    const {result} = analyzeSnapshot(data);
    const f = result.findings.find((x) => x.sourceSid === 'frame-btn')!;
    const token = f.tokens[0];
    const located = locateByPath(data, token.sid!, token.path!, data.revision);
    expect(located.found).toBe(true);
    expect(located.scopeKey).toBe('frame:one');
    expect(located.boundaryKinds).toEqual(['frame']);
    expect(located.liveRevealable).toBe(true);
  });

  it('marks closed-shadow targets as not live-revealable', () => {
    const closedHost = el('chost', 'x-b', {});
    attachShadow(closedHost, 'closed', 'shadow:closed', [
      el('cm', 'span', {id: 'cm'}, []),
      el('cb', 'button', {'aria-labelledby': 'cm'}, []),
    ]);
    const data = snapshot([{scopeKey: '#document', kind: 'top', children: [closedHost]}]);
    const {result} = analyzeSnapshot(data);
    const f = result.findings.find((x) => x.sourceSid === 'cb')!;
    const located = locateByPath(data, f.tokens[0].sid!, f.tokens[0].path!, data.revision);
    expect(located.found).toBe(true);
    expect(located.liveRevealable).toBe(false);
    expect(located.boundaryKinds).toEqual(['shadow-closed']);
  });

  it('fails replay when the path was produced against a different snapshot shape', () => {
    const data = frameFixtureLike();
    const {result} = analyzeSnapshot(data);
    const f = result.findings.find((x) => x.sourceSid === 'frame-btn')!;
    // Tamper: drop the target element from the snapshot but keep the stale path.
    const tampered: SnapshotData = JSON.parse(JSON.stringify(data));
    const frameDoc = tampered.documents.find((d) => d.scopeKey === 'frame:one')!;
    frameDoc.children = frameDoc.children.filter((n) => n.sid !== 'frame-label');
    const located = locateByPath(tampered, f.tokens[0].sid!, f.tokens[0].path!, data.revision);
    expect(located.found).toBe(false);
  });
});

function frameFixtureLike(): SnapshotData {
  const iframe = el('frame-el', 'iframe', {});
  return snapshot([
    {scopeKey: '#document', kind: 'top', children: [el('top-label', 'span', {id: 'ttl'}, []), iframe]},
    frame('frame:one', 'frame-el', [
      el('frame-label', 'span', {id: 'ttl'}, []),
      el('frame-btn', 'button', {'aria-labelledby': 'ttl'}, []),
    ]),
  ]);
}

describe('incremental scope cache', () => {
  function threeScopeFixture() {
    const openHost = el('ohost', 'x-a', {});
    attachShadow(openHost, 'open', 'shadow:a', [
      el('al', 'span', {id: 'al'}, []),
      el('ab', 'button', {'aria-labelledby': 'al'}, []),
    ]);
    const iframe = el('frame-el', 'iframe', {});
    const unrelatedLeaf = el('leaf', 'p', {}, [el('leaf-inner', 'span', {}, [])]);
    const data = snapshot([
      {scopeKey: '#document', kind: 'top', children: [openHost, iframe, unrelatedLeaf]},
      frame('frame:one', 'frame-el', [
        el('fl', 'span', {id: 'fl'}, []),
        el('fb', 'button', {'aria-labelledby': 'fl'}, []),
      ]),
    ]);
    return data;
  }

  it('rebuilds every scope on first analysis', () => {
    const {result} = analyzeSnapshot(threeScopeFixture());
    expect(result.stats.invalidatedScopes.sort()).toEqual(
      ['#document', 'frame:one', 'shadow:a'].sort(),
    );
  });

  it('reuses all scope indexes when revision is unchanged', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);
    const second = analyzeSnapshot(data, first.cache);
    expect(second.result.stats.indexRebuilds).toBe(0);
  });

  it('rebuilds only the scope owning a changed subtree', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);

    // Edit a node inside the shadow subtree only.
    const next = withAttr(data, 'al', 'data-note', 'x');
    const second = analyzeSnapshot(next, first.cache);
    expect(second.result.stats.invalidatedScopes).toEqual(['shadow:a']);

    // An unrelated later change in the frame touches just that scope.
    const third = analyzeSnapshot(withAttr(next, 'fl', 'data-note', 'y'), second.cache);
    expect(third.result.stats.invalidatedScopes).toEqual(['frame:one']);
  });

  it('does not rebuild the whole index when an id-less node deep in the document changes', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);
    const next = withAttr(data, 'leaf-inner', 'data-tick', String(Date.now()));
    const second = analyzeSnapshot(next, first.cache);
    expect(second.result.stats.invalidatedScopes).toEqual(['#document']);
    expect(second.result.stats.invalidatedScopes).not.toContain('frame:one');
    expect(second.result.stats.invalidatedScopes).not.toContain('shadow:a');
  });

  it('invalidates source and destination scopes when a node moves between them', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);

    // Move the frame's labelled node up into the top document.
    const next = movedIntoScope(data, 'fl', '#document');
    const second = analyzeSnapshot(next, first.cache);
    expect(second.result.stats.invalidatedScopes.sort()).toEqual(['#document', 'frame:one']);
    // shadow scope index was reused untouched
    expect(second.result.stats.invalidatedScopes).not.toContain('shadow:a');

    // The moved element keeps its sid and id 'fl'. The in-frame reference is
    // now cross-scope (the only 'fl' is in the top document).
    const frameBtn = second.result.findings.find((x) => x.sourceSid === 'fb')!;
    expect(frameBtn.tokens[0].status).toBe('cross-scope');
    expect(frameBtn.tokens[0].blockedBy?.[0].scopeKey).toBe('#document');
  });

  it('re-resolves correctly after a same-scope move', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);
    const next = moved(data, 'leaf-inner', 'ohost'); // stays in #document
    const second = analyzeSnapshot(next, first.cache);
    expect(second.result.stats.invalidatedScopes).toEqual(['#document']);
    // Existing resolution results are unaffected.
    const btn = second.result.findings.find((x) => x.sourceSid === 'ab')!;
    expect(btn.tokens[0].sid).toBe('al');
  });

  it('a no-op revision bump with identical tree still rebuilds nothing', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);
    const bumped = revise(data); // new revision, identical structure
    const second = analyzeSnapshot(bumped, first.cache);
    expect(second.result.stats.indexRebuilds).toBe(0);
  });

  it('detects a changed idref attribute as an edit in its owning scope', () => {
    const data = threeScopeFixture();
    const first = analyzeSnapshot(data);
    const next = withAttr(data, 'fb', 'aria-labelledby', 'ghost');
    const second = analyzeSnapshot(next, first.cache);
    expect(second.result.stats.invalidatedScopes).toEqual(['frame:one']);
    const f: IdRefFinding = second.result.findings.find((x) => x.sourceSid === 'fb')!;
    expect(f.tokens[0].status).toBe('missing');
  });
});
