/**
 * Demo snapshots used by the server and by tests.
 */
import type {Snapshot} from './types';
import {buildSnapshot} from './builder';

/**
 * Page deliberately containing every failure mode:
 *  - duplicate id "dup-title" twice in the top document
 *  - aria-labelledby with several tokens (one missing)
 *  - an open shadow root whose host references a light-DOM id (unreachable)
 *  - a closed shadow root referencing its own same-scope id
 *  - an iframe whose inner document reuses an id that also exists in the
 *    top document (a global map would silently cross the frame boundary)
 */
export function demoPage(): Snapshot {
  return buildSnapshot({
    tag: 'html',
    nid: 'doc-html',
    children: [
      {
        tag: 'body',
        nid: 'doc-body',
        children: [
          {
            tag: 'h1',
            nid: 'page-title',
            attrs: {id: 'title'},
            children: ['Components review'],
          },
          // Duplicate id in the SAME (top document) scope.
          {tag: 'section', nid: 'dup-a', attrs: {id: 'dup-title', class: 'card'}, children: ['First duplicate']},
          {tag: 'section', nid: 'dup-b', attrs: {id: 'dup-title', class: 'card'}, children: ['Second duplicate']},
          {
            // Multiple tokens: ok + ambiguous + missing.
            tag: 'button',
            nid: 'multi-btn',
            attrs: {'aria-labelledby': 'title dup-title gone-token'},
            children: ['Save'],
          },
          {
            // Single IDREF whose target simply does not exist.
            tag: 'input',
            nid: 'err-input',
            attrs: {'aria-errormessage': 'no-such-error', 'aria-invalid': 'true'},
          },
          {
            // Host of an OPEN shadow root. The reference inside the shadow
            // cannot see the light-DOM #title; the host-level reference
            // cannot see ids inside the shadow tree.
            tag: 'custom-card',
            nid: 'open-host',
            attrs: {'aria-labelledby': 'inside-open'},
            shadow: {
              mode: 'open',
              children: [
                {tag: 'span', nid: 'inside-open-el', attrs: {id: 'inside-open'}, children: ['Open shadow label']},
                {
                  tag: 'button',
                  nid: 'open-shadow-btn',
                  // #title lives in light DOM: unreachable across the boundary.
                  attrs: {'aria-labelledby': 'title'},
                  children: ['OK'],
                },
              ],
            },
          },
          {
            // CLOSED shadow root: live JS cannot enter it, but the captured
            // accessibility snapshot contains it and its own id namespace.
            tag: 'custom-secret',
            nid: 'closed-host',
            shadow: {
              mode: 'closed',
              children: [
                {tag: 'h2', nid: 'closed-heading', attrs: {id: 'closed-h'}, children: ['Closed shadow heading']},
                {
                  tag: 'button',
                  nid: 'closed-btn',
                  attrs: {'aria-describedby': 'closed-h'},
                  children: ['Reveal'],
                },
              ],
            },
          },
          {
            // Iframe: its document reuses "title" and "dup-title". A global
            // id map would merge these with the top-document nodes.
            tag: 'iframe',
            nid: 'frame',
            attrs: {title: 'Embedded widget'},
            document: {
              children: [
                {
                  tag: 'html',
                  nid: 'frame-html',
                  children: [
                    {
                      tag: 'body',
                      nid: 'frame-body',
                      children: [
                        {tag: 'h1', nid: 'frame-title', attrs: {id: 'title'}, children: ['Frame title']},
                        {tag: 'section', nid: 'frame-dup-a', attrs: {id: 'dup-title'}, children: ['Frame dup']},
                        {
                          tag: 'section',
                          nid: 'frame-dup-b',
                          attrs: {id: 'dup-title'},
                          children: ['Frame dup 2'],
                        },
                        {
                          tag: 'button',
                          nid: 'frame-btn',
                          attrs: {'aria-labelledby': 'title'},
                          children: ['Frame OK'],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  });
}
