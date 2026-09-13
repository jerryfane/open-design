import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildPreviewBaseHrefBridge } from '../src/runtime/preview-observability.js';

interface FakeElement {
  scrolled: Array<Record<string, unknown>>;
  scrollIntoView(options: Record<string, unknown>): void;
}

interface FakeClickEvent {
  defaultPrevented: boolean;
}

/**
 * The bridge ships as a script string injected into previewed artifacts, so
 * the behavior under test only exists once that string runs against a DOM.
 * Same approach as `apps/daemon/tests/frame-runtime.test.ts`: execute it in a
 * sandbox whose document exposes exactly the surface the script touches.
 */
function runBridge(options: { withContainmentBase: boolean; targets?: readonly string[] }) {
  const elements: Record<string, FakeElement> = {};
  for (const id of options.targets ?? []) {
    const scrolled: Array<Record<string, unknown>> = [];
    elements[id] = {
      scrolled,
      scrollIntoView(received: Record<string, unknown>) {
        scrolled.push(received);
      },
    };
  }
  const clickHandlers: Array<(event: unknown) => void> = [];
  const scrollToCalls: Array<readonly [number, number]> = [];

  const document = {
    baseURI: 'http://127.0.0.1:8796/api/projects/p1/preview/scope-1/',
    documentElement: { scrollIntoView() {} },
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (type === 'click') clickHandlers.push(handler);
    },
    querySelector(selector: string) {
      if (selector !== 'base[data-od-project-preview-base]') return null;
      return options.withContainmentBase ? { setAttribute() {} } : null;
    },
    getElementById(id: string) {
      return elements[id] ?? null;
    },
    getElementsByName() {
      return [];
    },
  };

  const sandbox = {
    document,
    URL,
    window: {
      document,
      parent: { postMessage() {} },
      addEventListener() {},
      scrollTo(left: number, top: number) {
        scrollToCalls.push([left, top]);
      },
    },
  };

  const script = buildPreviewBaseHrefBridge({
    href: '/api/projects/p1/preview/scope-1/',
    expiresAt: 1_700_000_000_000,
  })
    .replace(/^<script data-od-preview-base-bridge>/, '')
    .replace(/<\/script>$/, '');
  runInNewContext(script, sandbox);
  expect(clickHandlers).toHaveLength(1);

  const click = (
    link: { href: string; target?: string; download?: boolean },
    overrides: Record<string, unknown> = {},
  ): FakeClickEvent => {
    const node = {
      getAttribute(name: string) {
        if (name === 'href') return link.href;
        if (name === 'target') return link.target ?? null;
        return null;
      },
      hasAttribute(name: string) {
        return name === 'download' && link.download === true;
      },
      closest(selector: string) {
        return selector === 'a[href]' ? node : null;
      },
    };
    const event = {
      target: node,
      button: 0,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...overrides,
    };
    for (const handler of clickHandlers) handler(event);
    return event;
  };

  return { click, elements, scrollToCalls };
}

describe('preview base href bridge', () => {
  it('scrolls an in-page anchor instead of leaving the previewed document', () => {
    const bridge = runBridge({ withContainmentBase: true, targets: ['proposal-02'] });

    const event = bridge.click({ href: '#proposal-02' });

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.elements['proposal-02']?.scrolled).toEqual([
      { behavior: 'auto', block: 'start' },
    ]);
  });

  it('claims a fragment that resolves to nothing rather than letting it unload the preview', () => {
    const bridge = runBridge({ withContainmentBase: true });

    const event = bridge.click({ href: '#missing-section' });

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.scrollToCalls).toEqual([]);
  });

  it('sends a bare hash to the top of the document', () => {
    const bridge = runBridge({ withContainmentBase: true });

    const event = bridge.click({ href: '#' });

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.scrollToCalls).toEqual([[0, 0]]);
  });

  it('leaves fragment links alone when no containment base governs the document', () => {
    const bridge = runBridge({ withContainmentBase: false, targets: ['proposal-02'] });

    const event = bridge.click({ href: '#proposal-02' });

    expect(event.defaultPrevented).toBe(false);
    expect(bridge.elements['proposal-02']?.scrolled).toEqual([]);
  });

  it('keeps file links, new-tab links, and downloads on their normal path', () => {
    const bridge = runBridge({ withContainmentBase: true, targets: ['proposal-02'] });

    expect(bridge.click({ href: 'gallery.html' }).defaultPrevented).toBe(false);
    expect(bridge.click({ href: '#proposal-02', target: '_blank' }).defaultPrevented).toBe(false);
    expect(bridge.click({ href: '#proposal-02', download: true }).defaultPrevented).toBe(false);
    expect(bridge.elements['proposal-02']?.scrolled).toEqual([]);
  });

  it('ignores modified and non-primary clicks so open-in-new-tab still works', () => {
    const bridge = runBridge({ withContainmentBase: true, targets: ['proposal-02'] });

    expect(bridge.click({ href: '#proposal-02' }, { metaKey: true }).defaultPrevented).toBe(false);
    expect(bridge.click({ href: '#proposal-02' }, { button: 1 }).defaultPrevented).toBe(false);
    expect(bridge.elements['proposal-02']?.scrolled).toEqual([]);
  });
});
