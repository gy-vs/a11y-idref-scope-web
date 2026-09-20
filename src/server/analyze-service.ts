import {analyzeSnapshot} from '../core/analyze';
import type {ScopeCacheState} from '../core/scope';
import type {SnapshotData} from '../core/types';
import {el, frame, snapshot, attachShadow} from '../core/builder';

/**
 * A captured page exercising every boundary the analyzer must reason about:
 * duplicate ids in one document, a multi-token aria-labelledby, a missing
 * target, same-id elements split across an iframe and across open/closed
 * shadow roots.
 */
export function demoSnapshot(): SnapshotData {
  // Top document.
  const headingA = el('top-heading', 'h1', {id: 'ttl'}, []);
  const headingB = el('top-heading-dup', 'h2', {id: 'ttl'}, []); // duplicate id -> ambiguity

  const labelled = el(
    'top-input',
    'input',
    {'aria-labelledby': 'ttl note ghost'}, // 3 tokens: resolve + resolve + missing
  );

  // Open shadow root whose inner span re-uses id "ttl". From light DOM this is
  // unreachable by IDREF (and vice-versa).
  const openHost = el('open-host', 'widget-card', {});
  const openInner = el('open-label', 'span', {id: 'ttl'}, []);
  const openButton = el('open-btn', 'button', {'aria-labelledby': 'ttl'}, []); // resolves inside shadow
  attachShadow(openHost, 'open', 'shadow:open-host', [openInner, openButton]);

  // Closed shadow root. Its internals are captured in the snapshot (the audit
  // agent can see them) but cannot be revealed in a live browser.
  const closedHost = el('closed-host', 'custom-toast', {});
  const closedInner = el('closed-label', 'span', {id: 'msg'}, []);
  const closedRef = el('closed-ref', 'button', {'aria-labelledby': 'msg'}, []);
  attachShadow(closedHost, 'closed', 'shadow:closed-host', [closedInner, closedRef]);

  // The light-DOM element referencing "msg": the only same-id match lives in
  // the closed shadow => cross-scope diagnostic, never a false resolve.
  const closedProbe = el('closed-probe', 'button', {'aria-labelledby': 'msg'}, []);

  // The iframe host lives in the top document; its captured document is a
  // separate TreeScope linked through hostSid.
  const iframeElement = el('frame-host', 'iframe', {title: 'Checkout frame'}, []);

  const top = snapshot(
    [
      {
        scopeKey: '#document',
        kind: 'top' as const,
        children: [headingA, headingB, labelled, openHost, closedHost, closedProbe, iframeElement],
      },
      // Same id "ttl" exists inside the iframe too: must not leak across the
      // frame boundary in either direction.
      frame(
        'frame:checkout',
        'frame-host',
        [el('frame-heading', 'h3', {id: 'ttl'}, []), el('frame-input', 'input', {'aria-labelledby': 'ttl'}, [])],
        'Checkout frame',
      ),
    ],
    1,
  );
  return top;
}

// Server-side cache retained across analyses of the same evolving snapshot.
// Revision keyed: a revision bump reuses unaffected scope indexes.
const cacheStore = new Map<string, ScopeCacheState>();

export interface AnalyzeHttpResult {
  status: number;
  body: unknown;
}

export function analyzeSnapshotHttp(body: unknown): AnalyzeHttpResult {
  if (!isSnapshot(body)) return {status: 400, body: {error: 'invalid_snapshot'}};
  const prev = cacheStore.get(cacheKey(body));
  const {result, cache} = analyzeSnapshot(body, prev);
  cacheStore.set(cacheKey(body), cache);
  return {status: 200, body: result};
}

function cacheKey(data: SnapshotData): string {
  // The demo/UI work with a single captured document; revision suffices.
  return `rev:${data.revision}`;
}

function isSnapshot(value: unknown): value is SnapshotData {
  if (!value || typeof value !== 'object') return false;
  const v = value as SnapshotData;
  return (
    typeof v.revision === 'number' &&
    Array.isArray(v.documents) &&
    v.documents.every(
      (d) => typeof d.scopeKey === 'string' && Array.isArray(d.children),
    )
  );
}
