import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';

export const NATIVE_COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;

interface NativeCommandCacheEntry {
  candidates: ClaudeNativeSessionCandidate[];
  createdAt: number;
}

export class NativeCommandCandidateCache {
  private readonly entries = new Map<string, NativeCommandCacheEntry>();

  set(chatKey: string, candidates: ClaudeNativeSessionCandidate[], now = Date.now()): void {
    this.entries.set(chatKey, {
      candidates,
      createdAt: now,
    });
  }

  get(chatKey: string, now = Date.now()): ClaudeNativeSessionCandidate[] | null {
    const entry = this.entries.get(chatKey);
    if (!entry) {
      return null;
    }

    if (now - entry.createdAt >= NATIVE_COMMAND_CACHE_TTL_MS) {
      this.entries.delete(chatKey);
      return null;
    }

    return entry.candidates;
  }

  clear(chatKey: string): void {
    this.entries.delete(chatKey);
  }
}
