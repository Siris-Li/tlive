import type { NativeVisibleMessage } from './claude-native-scanner.js';

export const RECENT_CONTEXT_EXPAND_THRESHOLD = 1500;
export const LONG_ASSISTANT_SKIP_THRESHOLD = 6000;
export const TELEGRAM_SAFE_PAGE_LIMIT = 3900;

const LONG_ASSISTANT_SKIP_NOTICE = '[assistant message omitted: too long for recent context]';
const SINGLE_PAGE_HEADER = '<b>Recent context</b>\n';

export type RecentContextMode = 'resume' | 'current';

export type SelectedRecentContextItem =
  | { kind: 'message'; message: NativeVisibleMessage }
  | { kind: 'skip'; text: string; timestamp?: string };

export interface SelectRecentContextMessagesOptions {
  mode?: RecentContextMode;
}

export interface RenderRecentContextPagesOptions extends SelectRecentContextMessagesOptions {
  pageLimit?: number;
}

export function selectRecentContextMessages(
  messages: NativeVisibleMessage[],
  options: SelectRecentContextMessagesOptions = {},
): SelectedRecentContextItem[] {
  const mode = options.mode ?? 'resume';
  const selected: SelectedRecentContextItem[] = [];
  let completeMessageCount = 0;
  let selectedCharCount = 0;
  let index = messages.length - 1;

  const collectUntil = (targetCount: number) => {
    while (index >= 0 && completeMessageCount < targetCount) {
      const message = messages[index--];
      if (message.role === 'assistant' && message.text.length > LONG_ASSISTANT_SKIP_THRESHOLD) {
        selected.unshift(createLongAssistantSkipNotice(message));
        continue;
      }

      selected.unshift({ kind: 'message', message });
      completeMessageCount += 1;
      selectedCharCount += message.text.length;
    }
  };

  collectUntil(3);

  if (mode === 'resume' && completeMessageCount === 3 && selectedCharCount < RECENT_CONTEXT_EXPAND_THRESHOLD) {
    collectUntil(5);
  }

  return selected;
}

export function renderRecentContextPages(
  messages: NativeVisibleMessage[],
  options: RenderRecentContextPagesOptions = {},
): string[] {
  const selectedMessages = selectRecentContextMessages(messages, options);
  if (selectedMessages.length === 0) {
    return [formatPage('No recent visible context.', 1, 1)];
  }

  const pageLimit = normalizePageLimit(options.pageLimit);
  let estimatedTotalPages = 1;
  let pageBodies = paginateSelectedMessages(selectedMessages, pageLimit, estimatedTotalPages);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actualTotalPages = pageBodies.length;
    if (actualTotalPages === estimatedTotalPages) {
      break;
    }

    estimatedTotalPages = actualTotalPages;
    pageBodies = paginateSelectedMessages(selectedMessages, pageLimit, estimatedTotalPages);
  }

  const totalPages = pageBodies.length;
  return pageBodies.map((body, index) => formatPage(body, index + 1, totalPages));
}

function createLongAssistantSkipNotice(message: NativeVisibleMessage): SelectedRecentContextItem {
  const notice: SelectedRecentContextItem = {
    kind: 'skip',
    text: LONG_ASSISTANT_SKIP_NOTICE,
  };

  if (message.timestamp) {
    notice.timestamp = message.timestamp;
  }

  return notice;
}

function paginateSelectedMessages(
  messages: SelectedRecentContextItem[],
  pageLimit: number,
  totalPages: number,
): string[] {
  const pages: string[] = [];
  let currentBody = '';

  for (const item of messages) {
    const prefix = item.kind === 'message'
      ? item.message.role === 'user' ? 'U: ' : 'A: '
      : 'A: ';
    let remainingText = item.kind === 'message' ? item.message.text : item.text;
    let needsAtLeastOneChunk = true;

    while (needsAtLeastOneChunk || remainingText.length > 0) {
      const separator = currentBody === '' ? '' : '\n\n';
      const pageNumber = pages.length + 1;
      const availableEscapedLength =
        pageLimit -
        getPageWrapperLength(pageNumber, totalPages) -
        currentBody.length -
        separator.length -
        prefix.length;

      if (availableEscapedLength <= 0) {
        if (currentBody !== '') {
          pages.push(currentBody);
          currentBody = '';
          continue;
        }

        const forcedChunk = takeFirstCodePoint(remainingText);
        currentBody = `${prefix}${escapeHtml(forcedChunk)}`;
        remainingText = remainingText.slice(forcedChunk.length);
        needsAtLeastOneChunk = false;
        pages.push(currentBody);
        currentBody = '';
        continue;
      }

      const chunkLength = needsAtLeastOneChunk && remainingText.length === 0
        ? 0
        : takeRawTextChunkLength(remainingText, availableEscapedLength);

      if (chunkLength === 0 && remainingText.length > 0) {
        if (currentBody !== '') {
          pages.push(currentBody);
          currentBody = '';
          continue;
        }

        const forcedChunk = takeFirstCodePoint(remainingText);
        currentBody = `${prefix}${escapeHtml(forcedChunk)}`;
        remainingText = remainingText.slice(forcedChunk.length);
        needsAtLeastOneChunk = false;
        pages.push(currentBody);
        currentBody = '';
        continue;
      }

      const chunkText = remainingText.slice(0, chunkLength);
      currentBody += `${separator}${prefix}${escapeHtml(chunkText)}`;
      remainingText = remainingText.slice(chunkLength);
      needsAtLeastOneChunk = false;

      if (remainingText.length > 0) {
        pages.push(currentBody);
        currentBody = '';
      }
    }
  }

  if (currentBody !== '') {
    pages.push(currentBody);
  }

  return pages;
}

function takeRawTextChunkLength(text: string, maxEscapedLength: number): number {
  let escapedLength = 0;
  let index = 0;

  for (const codePoint of text) {
    const nextLength = escapedLength + getEscapedLength(codePoint);
    if (nextLength > maxEscapedLength) {
      break;
    }

    escapedLength = nextLength;
    index += codePoint.length;
  }

  return index;
}

function takeFirstCodePoint(text: string): string {
  return Array.from(text)[0] ?? '';
}

function getEscapedLength(char: string): number {
  switch (char) {
    case '&':
      return 5;
    case '<':
    case '>':
      return 4;
    default:
      return char.length;
  }
}

function getPageWrapperLength(pageNumber: number, totalPages: number): number {
  return getPageHeader(pageNumber, totalPages).length + '<pre></pre>'.length;
}

function getPageHeader(pageNumber: number, totalPages: number): string {
  if (totalPages <= 1) {
    return SINGLE_PAGE_HEADER;
  }

  return `<b>Recent context (${pageNumber}/${totalPages})</b>\n`;
}

function formatPage(body: string, pageNumber: number, totalPages: number): string {
  return `${getPageHeader(pageNumber, totalPages)}<pre>${body}</pre>`;
}

function normalizePageLimit(pageLimit: number | undefined): number {
  if (typeof pageLimit !== 'number' || !Number.isFinite(pageLimit) || pageLimit <= 0) {
    return TELEGRAM_SAFE_PAGE_LIMIT;
  }

  return Math.floor(pageLimit);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
