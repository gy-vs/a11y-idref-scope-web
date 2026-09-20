import {expect, it} from 'vitest';
import {analyzeSnapshotHttp, demoSnapshot} from '../src/server/analyze-service';
import {analyzeSnapshot} from '../src/core/analyze';

it('demo snapshot covers duplicate ids, multi-token, cross-scope and both shadow modes', () => {
  const {result} = analyzeSnapshot(demoSnapshot());

  // top-input references 'ttl note ghost':
  //  - 'ttl' is duplicated in the top document => ambiguous (both candidates)
  //  - 'note' does not exist anywhere => missing
  //  - 'ghost' likewise => missing
  const multi = result.findings.find((f) => f.sourceSid === 'top-input')!;
  expect(multi.tokens.map((t) => [t.token, t.status])).toEqual([
    ['ttl', 'ambiguous'],
    ['note', 'missing'],
    ['ghost', 'missing'],
  ]);
  expect(multi.tokens[0].candidates).toEqual(['top-heading', 'top-heading-dup']);
  // Cross-boundary same-ids are reported as blocked but never chosen.
  expect(multi.tokens[0].blockedBy?.map((b) => b.scopeKey).sort()).toEqual([
    'frame:checkout',
    'shadow:open-host',
  ]);

  // Open shadow internal reference resolves strictly in-scope.
  const openBtn = result.findings.find((f) => f.sourceSid === 'open-btn')!;
  expect(openBtn.tokens[0]).toMatchObject({status: 'resolved', sid: 'open-label'});

  // Closed shadow internals are captured and resolvable in the snapshot.
  const closedBtn = result.findings.find((f) => f.sourceSid === 'closed-ref')!;
  expect(closedBtn.tokens[0]).toMatchObject({status: 'resolved', sid: 'closed-label'});
  expect(closedBtn.tokens[0].path?.some((s) => s.boundary === 'shadow-closed')).toBe(true);

  // The light-DOM 'msg' reference can only match inside the closed shadow.
  const probe = result.findings.find((f) => f.sourceSid === 'closed-probe')!;
  expect(probe.tokens[0].status).toBe('cross-scope');
  expect(probe.tokens[0].blockedBy?.[0]).toMatchObject({
    scopeKey: 'shadow:closed-host',
    kind: 'shadow-closed',
    sid: 'closed-label',
  });

  // The iframe keeps its own id space; its 'ttl' is independent of the top's.
  const frameBtn = result.findings.find((f) => f.sourceSid === 'frame-input')!;
  expect(frameBtn.tokens[0]).toMatchObject({status: 'resolved', sid: 'frame-heading'});
  expect(frameBtn.tokens[0].path?.some((s) => s.boundary === 'frame')).toBe(true);
});

it('HTTP layer validates the snapshot body', () => {
  expect(analyzeSnapshotHttp({}).status).toBe(400);
  const ok = analyzeSnapshotHttp(demoSnapshot());
  expect(ok.status).toBe(200);
});
