import { describe, expect, it } from 'vitest';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import {
  NativeCommandCandidateCache,
  NATIVE_COMMAND_CACHE_TTL_MS,
} from '../engine/native-command-cache.js';

const BASE_TIME = Date.parse('2026-05-06T12:00:00.000Z');

function makeCandidate(sessionId: string): ClaudeNativeSessionCandidate {
  return {
    sessionId,
    sourcePath: `C:/tmp/${sessionId}.jsonl`,
    cwd: 'D:\\SirisLi\\GitHub\\tlive',
    cwdSource: 'jsonl',
    cwdExists: true,
    lastActivityAt: new Date(BASE_TIME).toISOString(),
    preview: `preview-${sessionId}`,
    nativePreview: `native-preview-${sessionId}`,
    recentMessages: [],
    isSidechain: false,
  };
}

describe('NativeCommandCandidateCache', () => {
  it('stores candidates per chat key for five minutes', () => {
    const cache = new NativeCommandCandidateCache();
    const candidates = [makeCandidate('session-1')];

    expect(NATIVE_COMMAND_CACHE_TTL_MS).toBe(5 * 60 * 1000);

    cache.set('telegram:chat-1', candidates, BASE_TIME);

    expect(cache.get('telegram:chat-1', BASE_TIME + NATIVE_COMMAND_CACHE_TTL_MS - 1)).toEqual(candidates);
    expect(cache.get('telegram:chat-1', BASE_TIME + NATIVE_COMMAND_CACHE_TTL_MS)).toBeNull();
  });

  it('clears one chat without affecting another', () => {
    const cache = new NativeCommandCandidateCache();
    const firstCandidates = [makeCandidate('session-1')];
    const secondCandidates = [makeCandidate('session-2')];

    cache.set('telegram:chat-1', firstCandidates, BASE_TIME);
    cache.set('telegram:chat-2', secondCandidates, BASE_TIME);
    cache.clear('telegram:chat-1');

    expect(cache.get('telegram:chat-1', BASE_TIME + 1)).toBeNull();
    expect(cache.get('telegram:chat-2', BASE_TIME + 1)).toEqual(secondCandidates);
  });

  it('overwrites old candidates and resets createdAt on a new set', () => {
    const cache = new NativeCommandCandidateCache();
    const oldCandidates = [makeCandidate('session-old')];
    const newCandidates = [makeCandidate('session-new')];
    const refreshedAt = BASE_TIME + 30_000;

    cache.set('telegram:chat-1', oldCandidates, BASE_TIME);
    cache.set('telegram:chat-1', newCandidates, refreshedAt);

    expect(cache.get('telegram:chat-1', refreshedAt + NATIVE_COMMAND_CACHE_TTL_MS - 1)).toEqual(newCandidates);
    expect(cache.get('telegram:chat-1', refreshedAt + NATIVE_COMMAND_CACHE_TTL_MS)).toBeNull();
  });
});
