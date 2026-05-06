import { describe, expect, it } from 'vitest';
import type { NativeVisibleMessage } from '../native/claude-native-scanner.js';
import type { SelectedRecentContextItem } from '../native/recent-context.js';
import {
  LONG_ASSISTANT_SKIP_THRESHOLD,
  RECENT_CONTEXT_EXPAND_THRESHOLD,
  TELEGRAM_SAFE_PAGE_LIMIT,
  renderRecentContextPages,
  selectRecentContextMessages,
} from '../native/recent-context.js';

const LONG_ASSISTANT_SKIP_TEXT = '[assistant message omitted: too long for recent context]';

function message(
  role: NativeVisibleMessage['role'],
  text: string,
  timestamp?: string,
): NativeVisibleMessage {
  return timestamp ? { role, text, timestamp } : { role, text };
}

function selectedMessage(message: NativeVisibleMessage): SelectedRecentContextItem {
  return { kind: 'message', message };
}

function skipItem(text: string, timestamp?: string): SelectedRecentContextItem {
  return timestamp ? { kind: 'skip', text, timestamp } : { kind: 'skip', text };
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }

      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

describe('recent-context', () => {
  it('exports the expected thresholds and limits', () => {
    expect(RECENT_CONTEXT_EXPAND_THRESHOLD).toBe(1500);
    expect(LONG_ASSISTANT_SKIP_THRESHOLD).toBe(6000);
    expect(TELEGRAM_SAFE_PAGE_LIMIT).toBe(3900);
  });

  it('selects the latest 3 messages in old-to-new order by default', () => {
    const selected = selectRecentContextMessages([
      message('user', 'older user'),
      message('assistant', 'older assistant'),
      message('user', 'u'.repeat(600)),
      message('assistant', 'a'.repeat(500)),
      message('user', 'z'.repeat(400)),
    ]);

    expect(selected).toEqual([
      selectedMessage(message('user', 'u'.repeat(600))),
      selectedMessage(message('assistant', 'a'.repeat(500))),
      selectedMessage(message('user', 'z'.repeat(400))),
    ]);
  });

  it('expands to 5 messages when the latest 3 are under the resume threshold', () => {
    const selected = selectRecentContextMessages([
      message('user', 'u1'),
      message('assistant', 'a1'),
      message('user', 'u2'),
      message('assistant', 'a2'),
      message('user', 'u3'),
      message('assistant', 'a3'),
    ]);

    expect(selected).toEqual([
      selectedMessage(message('assistant', 'a1')),
      selectedMessage(message('user', 'u2')),
      selectedMessage(message('assistant', 'a2')),
      selectedMessage(message('user', 'u3')),
      selectedMessage(message('assistant', 'a3')),
    ]);
  });

  it('uses at most 3 messages in current mode', () => {
    const selected = selectRecentContextMessages(
      [
        message('user', 'u1'),
        message('assistant', 'a1'),
        message('user', 'u2'),
        message('assistant', 'a2'),
        message('user', 'u3'),
        message('assistant', 'a3'),
      ],
      { mode: 'current' },
    );

    expect(selected).toEqual([
      selectedMessage(message('assistant', 'a2')),
      selectedMessage(message('user', 'u3')),
      selectedMessage(message('assistant', 'a3')),
    ]);
  });

  it('returns a structural skip item for long assistants and keeps filling with earlier messages', () => {
    const timestamp = '2026-05-06T12:34:56Z';
    const selected = selectRecentContextMessages([
      message('user', 'older user'),
      message('assistant', 'old assistant'),
      message('user', 'u'.repeat(700)),
      message('assistant', 'x'.repeat(LONG_ASSISTANT_SKIP_THRESHOLD + 1), timestamp),
      message('user', 'v'.repeat(500)),
      message('assistant', 'w'.repeat(400)),
    ]);

    expect(selected).toEqual([
      selectedMessage(message('user', 'u'.repeat(700))),
      skipItem(LONG_ASSISTANT_SKIP_TEXT, timestamp),
      selectedMessage(message('user', 'v'.repeat(500))),
      selectedMessage(message('assistant', 'w'.repeat(400))),
    ]);
  });

  it('renders structured skip items as assistant skip notices', () => {
    const pages = renderRecentContextPages(
      [message('assistant', 'x'.repeat(LONG_ASSISTANT_SKIP_THRESHOLD + 1))],
      { mode: 'current' },
    );

    expect(pages).toEqual([
      `<b>Recent context</b>\n<pre>A: ${LONG_ASSISTANT_SKIP_TEXT}</pre>`,
    ]);
  });

  it('renders long user messages across multiple pages without truncation and adds page markers', () => {
    const pageLimit = 160;
    const longUserText = 'segment-'.repeat(45);

    const pages = renderRecentContextPages([message('user', longUserText)], {
      mode: 'current',
      pageLimit,
    });

    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, index) => {
      expect(page.length).toBeLessThanOrEqual(pageLimit);
      expect(page).toContain(`(${index + 1}/${pages.length})`);
    });

    const reconstructed = pages
      .map(page => page.match(/<pre>([\s\S]*)<\/pre>/)?.[1] ?? '')
      .map(content => content.replace(/^U: /, ''))
      .join('');

    expect(reconstructed).toBe(longUserText);
  });

  it('paginates unicode text without splitting surrogate pairs and reconstructs exactly', () => {
    const unicodeText = `${'a🙂'.repeat(2)}${'🙂b𠮷a'.repeat(2)}`;
    const pageLimit = 41;

    const pages = renderRecentContextPages([message('user', unicodeText)], {
      mode: 'current',
      pageLimit,
    });

    expect(pages.length).toBeGreaterThan(1);

    const pageContents = pages.map(page => (page.match(/<pre>([\s\S]*)<\/pre>/)?.[1] ?? '').replace(/^U: /, ''));

    pageContents.forEach(content => {
      expect(hasUnpairedSurrogate(content)).toBe(false);
    });

    expect(pageContents.join('')).toBe(unicodeText);
  });

  it('escapes html and keeps pre blocks self-contained on every page', () => {
    const pages = renderRecentContextPages(
      [message('user', '<alpha>&beta>'.repeat(30))],
      { mode: 'current', pageLimit: 160 },
    );

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).toContain('&lt;alpha&gt;&amp;beta&gt;');
    expect(pages.join('\n')).not.toContain('<alpha>');

    for (const page of pages) {
      expect((page.match(/<pre>/g) ?? [])).toHaveLength(1);
      expect((page.match(/<\/pre>/g) ?? [])).toHaveLength(1);
    }
  });

  it('renders a fallback page when there is no recent visible context', () => {
    const pages = renderRecentContextPages([]);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/no recent visible context/i);
  });

  it('only expands resume mode when the latest 3 stay below the threshold', () => {
    const selected = selectRecentContextMessages([
      message('user', 'older user'),
      message('assistant', 'older assistant'),
      message('user', 'c'.repeat(700)),
      message('assistant', 'd'.repeat(500)),
      message('user', 'e'.repeat(400)),
    ]);

    expect(selected).toEqual([
      selectedMessage(message('user', 'c'.repeat(700))),
      selectedMessage(message('assistant', 'd'.repeat(500))),
      selectedMessage(message('user', 'e'.repeat(400))),
    ]);
  });
});
