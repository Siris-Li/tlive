import { describe, expect, it, vi } from 'vitest';
import { ClaudeLiveSession } from '../providers/claude-live-session.js';

let nextMessages: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const message of nextMessages) {
        yield message;
      }
    },
    interrupt: vi.fn(),
    stopTask: vi.fn(),
    setModel: vi.fn(),
    close: vi.fn(),
  })),
}));

function makeSession(): ClaudeLiveSession {
  return new ClaudeLiveSession({
    workingDirectory: 'C:\\repo',
    settingSources: [],
    pendingPerms: {
      create: vi.fn(),
      resolve: vi.fn(),
      reject: vi.fn(),
      waitFor: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      isPending: vi.fn(() => false),
    } as any,
  });
}

describe('ClaudeLiveSession', () => {
  it('closes the turn stream after an error-only result event', async () => {
    nextMessages = [
      {
        type: 'result',
        subtype: 'error',
        errors: ['boom'],
      },
    ];
    const session = makeSession();
    const result = session.startTurn('hello');
    await Promise.resolve();

    const reader = result.stream.getReader();
    const first = await reader.read();
    const second = await reader.read();

    expect(first.value).toEqual({ kind: 'error', message: 'boom' });
    expect(second.done).toBe(true);
  });
});
