import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import type { SessionData } from '../store/interface.js';

export const NATIVE_COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;

type NativeSessionSource = NonNullable<SessionData['source']>;

interface NativeCommandCacheEntry {
  candidates: ClaudeNativeSessionCandidate[];
  createdAt: number;
  source: NativeSessionSource;
}

export class NativeCommandCandidateCache {
  private readonly entries = new Map<string, NativeCommandCacheEntry>();

  set(
    chatKey: string,
    candidates: ClaudeNativeSessionCandidate[],
    now = Date.now(),
    source: NativeSessionSource = 'claude-native',
  ): void {
    this.entries.set(chatKey, {
      candidates,
      createdAt: now,
      source,
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

  getSource(chatKey: string, now = Date.now()): NativeSessionSource | null {
    const entry = this.entries.get(chatKey);
    if (!entry) {
      return null;
    }

    if (now - entry.createdAt >= NATIVE_COMMAND_CACHE_TTL_MS) {
      this.entries.delete(chatKey);
      return null;
    }

    return entry.source;
  }

  clear(chatKey: string): void {
    this.entries.delete(chatKey);
  }
}
