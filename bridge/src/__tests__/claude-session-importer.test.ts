import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BridgeStore,
  ChannelBinding,
  Message,
  NativeSessionLease,
  SessionData,
} from '../store/interface.js';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import {
  findImportedSessionBySdkSessionId,
  importCodexNativeSession,
  importClaudeNativeSession,
} from '../native/claude-session-importer.js';

const NOW = new Date('2026-05-06T12:34:56.789Z');
const NOW_ISO = NOW.toISOString();
const NOW_MS = NOW.getTime();

class MemoryBridgeStore implements BridgeStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(initialSessions: SessionData[] = []) {
    for (const session of initialSessions) {
      this.sessions.set(session.id, session);
    }
  }

  async getSession(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async listSessions(): Promise<SessionData[]> {
    return [...this.sessions.values()];
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async getNativeSessionLease(_sdkSessionId: string): Promise<NativeSessionLease | null> {
    return null;
  }

  async saveNativeSessionLease(_lease: NativeSessionLease): Promise<void> {}

  async deleteNativeSessionLease(_sdkSessionId: string): Promise<void> {}

  async listNativeSessionLeases(): Promise<NativeSessionLease[]> {
    return [];
  }

  async getMessages(_sessionId: string): Promise<Message[]> {
    return [];
  }

  async saveMessage(_sessionId: string, _message: Message): Promise<void> {}

  async getBinding(_channelType: string, _chatId: string): Promise<ChannelBinding | null> {
    return null;
  }

  async saveBinding(_binding: ChannelBinding): Promise<void> {}

  async deleteBinding(_channelType: string, _chatId: string): Promise<void> {}

  async listBindings(): Promise<ChannelBinding[]> {
    return [];
  }

  async isDuplicate(_messageId: string): Promise<boolean> {
    return false;
  }

  async markProcessed(_messageId: string): Promise<void> {}

  async acquireLock(_key: string, _ttlMs: number): Promise<boolean> {
    return true;
  }

  async renewLock(_key: string, _ttlMs: number): Promise<boolean> {
    return true;
  }

  async releaseLock(_key: string): Promise<void> {}
}

function makeCandidate(overrides: Partial<ClaudeNativeSessionCandidate> = {}): ClaudeNativeSessionCandidate {
  return {
    sessionId: overrides.sessionId ?? '1234567890abcdef',
    sourcePath: overrides.sourcePath ?? 'D:\\native\\1234567890abcdef.jsonl',
    cwd: overrides.cwd ?? 'D:\\repo\\candidate',
    cwdSource: overrides.cwdSource ?? 'jsonl',
    cwdExists: overrides.cwdExists ?? true,
    lastActivityAt: overrides.lastActivityAt ?? '2026-05-06T12:00:00.000Z',
    preview: overrides.preview ?? 'preview text',
    nativePreview: overrides.nativePreview ?? 'native preview text',
    recentMessages: overrides.recentMessages ?? [],
    gitBranch: overrides.gitBranch,
    version: overrides.version,
    isSidechain: overrides.isSidechain ?? false,
    filenameSessionId: overrides.filenameSessionId,
    sessionIdMismatch: overrides.sessionIdMismatch,
  };
}

describe('claude-session-importer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates an imported session from a native candidate', async () => {
    const store = new MemoryBridgeStore();
    const candidate = makeCandidate({
      sessionId: 'abc1234567890fed',
      cwd: 'D:\\repo\\from-candidate',
      sourcePath: 'D:\\native\\abc1234567890fed.jsonl',
      lastActivityAt: '2026-05-06T11:59:00.000Z',
      nativePreview: 'latest imported preview',
    });

    const session = await importClaudeNativeSession(store, candidate);

    expect(session).toEqual({
      id: `session-imported-67890fed-${NOW_MS}`,
      workingDirectory: 'D:\\repo\\from-candidate',
      sdkSessionId: 'abc1234567890fed',
      source: 'claude-native',
      sourcePath: 'D:\\native\\abc1234567890fed.jsonl',
      importedAt: NOW_ISO,
      lastNativeActivityAt: '2026-05-06T11:59:00.000Z',
      nativePreview: 'latest imported preview',
      createdAt: NOW_ISO,
    });
    expect(await store.listSessions()).toEqual([session]);
  });

  it('reuses an existing imported session by sdk session id and refreshes native metadata', async () => {
    const existing: SessionData = {
      id: 'session-imported-67890fed-1111111111111',
      workingDirectory: 'D:\\repo\\old',
      sdkSessionId: 'abc1234567890fed',
      source: 'claude-native',
      sourcePath: 'D:\\native\\old.jsonl',
      importedAt: '2026-05-05T10:00:00.000Z',
      lastNativeActivityAt: '2026-05-05T10:05:00.000Z',
      nativePreview: 'old preview',
      createdAt: '2026-05-05T10:00:00.000Z',
      model: 'claude-sonnet',
      mode: 'default',
    };
    const store = new MemoryBridgeStore([existing]);
    const candidate = makeCandidate({
      sessionId: 'abc1234567890fed',
      cwd: 'D:\\repo\\updated',
      sourcePath: 'D:\\native\\updated.jsonl',
      lastActivityAt: '2026-05-06T12:20:00.000Z',
      nativePreview: 'updated preview',
    });

    const session = await importClaudeNativeSession(store, candidate);

    expect(session).toEqual({
      ...existing,
      workingDirectory: 'D:\\repo\\updated',
      sourcePath: 'D:\\native\\updated.jsonl',
      lastNativeActivityAt: '2026-05-06T12:20:00.000Z',
      nativePreview: 'updated preview',
    });
    expect(await store.listSessions()).toEqual([session]);
  });

  it('prefers cwdOverride over candidate cwd', async () => {
    const store = new MemoryBridgeStore();
    const candidate = makeCandidate({
      sessionId: 'override-target',
      cwd: 'D:\\repo\\candidate-cwd',
    });

    const session = await importClaudeNativeSession(store, candidate, {
      cwdOverride: 'D:\\repo\\override-cwd',
    });

    expect(session.workingDirectory).toBe('D:\\repo\\override-cwd');
  });

  it('finds the first matching imported native session and ignores non-native matches', async () => {
    const firstNative: SessionData = {
      id: 'native-1',
      workingDirectory: 'D:\\repo\\native-1',
      sdkSessionId: 'sdk-match',
      source: 'claude-native',
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const secondNative: SessionData = {
      id: 'native-2',
      workingDirectory: 'D:\\repo\\native-2',
      sdkSessionId: 'sdk-match',
      source: 'claude-native',
      createdAt: '2026-05-02T00:00:00.000Z',
    };
    const store = new MemoryBridgeStore([
      {
        id: 'non-native',
        workingDirectory: 'D:\\repo\\non-native',
        sdkSessionId: 'sdk-match',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
      firstNative,
      secondNative,
    ]);

    expect(await findImportedSessionBySdkSessionId(store, 'sdk-match')).toEqual(firstNative);
    expect(await findImportedSessionBySdkSessionId(store, 'missing-sdk')).toBeNull();
  });

  it('creates a Codex native imported session without colliding with Claude imports', async () => {
    const store = new MemoryBridgeStore([
      {
        id: 'claude-import',
        workingDirectory: 'D:\\repo\\claude',
        sdkSessionId: 'shared-sdk-id',
        source: 'claude-native',
        createdAt: '2026-05-05T10:00:00.000Z',
      },
    ]);
    const candidate = makeCandidate({
      sessionId: 'shared-sdk-id',
      cwd: 'D:\\repo\\codex',
      sourcePath: 'C:\\Users\\SirisLi\\.codex\\sessions\\shared-sdk-id.jsonl',
      lastActivityAt: '2026-05-06T12:20:00.000Z',
      nativePreview: 'codex imported preview',
    });

    const session = await importCodexNativeSession(store, candidate);

    expect(session).toEqual({
      id: `session-imported-d-sdk-id-${NOW_MS}`,
      workingDirectory: 'D:\\repo\\codex',
      sdkSessionId: 'shared-sdk-id',
      source: 'codex-native',
      sourcePath: 'C:\\Users\\SirisLi\\.codex\\sessions\\shared-sdk-id.jsonl',
      importedAt: NOW_ISO,
      lastNativeActivityAt: '2026-05-06T12:20:00.000Z',
      nativePreview: 'codex imported preview',
      createdAt: NOW_ISO,
    });
    expect(await findImportedSessionBySdkSessionId(store, 'shared-sdk-id', 'codex-native')).toEqual(session);
    expect(await findImportedSessionBySdkSessionId(store, 'shared-sdk-id', 'claude-native')).toEqual(
      expect.objectContaining({ id: 'claude-import' }),
    );
  });
});
