import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BaseChannelAdapter } from '../channels/base.js';
import { initBridgeContext } from '../context.js';
import { NativeCommandCandidateCache } from '../engine/native-command-cache.js';
import { CommandRouter } from '../engine/command-router.js';
import { ChannelRouter } from '../engine/router.js';
import { SessionStateManager } from '../engine/session-state.js';
import {
  NativeSessionLeaseService,
  NATIVE_LEASE_TTL_MINUTES,
  nativeLeaseOwner,
} from '../native/native-session-lease.js';
import type {
  BridgeStore,
  ChannelBinding,
  Message,
  NativeSessionLease,
  SessionData,
} from '../store/interface.js';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';

const CHAT_ID = 'chat-1';
const USER_ID = 'user-1';
const CHANNEL_TYPE = 'telegram';
const NOW_ISO = '2026-05-06T12:00:00.000Z';

class MemoryStore implements BridgeStore {
  private readonly sessions = new Map<string, SessionData>();
  private readonly messages = new Map<string, Message[]>();
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly leases = new Map<string, NativeSessionLease>();
  private readonly processed = new Set<string>();

  async getSession(id: string): Promise<SessionData | null> {
    return this.sessions.get(id) ?? null;
  }

  async saveSession(session: SessionData): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async listSessions(): Promise<SessionData[]> {
    return Array.from(this.sessions.values()).map(session => ({ ...session }));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async getNativeSessionLease(sdkSessionId: string): Promise<NativeSessionLease | null> {
    return this.leases.get(sdkSessionId) ?? null;
  }

  async saveNativeSessionLease(lease: NativeSessionLease): Promise<void> {
    this.leases.set(lease.sdkSessionId, { ...lease });
  }

  async deleteNativeSessionLease(sdkSessionId: string): Promise<void> {
    this.leases.delete(sdkSessionId);
  }

  async listNativeSessionLeases(): Promise<NativeSessionLease[]> {
    return Array.from(this.leases.values()).map(lease => ({ ...lease }));
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return (this.messages.get(sessionId) ?? []).map(message => ({ ...message }));
  }

  async saveMessage(sessionId: string, message: Message): Promise<void> {
    const existing = this.messages.get(sessionId) ?? [];
    existing.push({ ...message });
    this.messages.set(sessionId, existing);
  }

  async getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null> {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  async saveBinding(binding: ChannelBinding): Promise<void> {
    this.bindings.set(`${binding.channelType}:${binding.chatId}`, { ...binding });
  }

  async deleteBinding(channelType: string, chatId: string): Promise<void> {
    this.bindings.delete(`${channelType}:${chatId}`);
  }

  async listBindings(): Promise<ChannelBinding[]> {
    return Array.from(this.bindings.values()).map(binding => ({ ...binding }));
  }

  async isDuplicate(messageId: string): Promise<boolean> {
    return this.processed.has(messageId);
  }

  async markProcessed(messageId: string): Promise<void> {
    this.processed.add(messageId);
  }

  async acquireLock(): Promise<boolean> {
    return true;
  }

  async renewLock(): Promise<boolean> {
    return true;
  }

  async releaseLock(): Promise<void> {}
}

function mockAdapter(channelType = CHANNEL_TYPE): BaseChannelAdapter {
  return {
    channelType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeOne: vi.fn().mockResolvedValue(null),
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-1' }),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(null),
    isAuthorized: vi.fn().mockReturnValue(true),
  } as unknown as BaseChannelAdapter;
}

function makeCandidate(
  sessionId: string,
  overrides: Partial<ClaudeNativeSessionCandidate> = {},
): ClaudeNativeSessionCandidate {
  return {
    sessionId,
    sourcePath: `C:\\history\\${sessionId}.jsonl`,
    cwd: 'C:\\repo',
    cwdSource: 'jsonl',
    cwdExists: true,
    lastActivityAt: NOW_ISO,
    preview: `preview-${sessionId}`,
    nativePreview: `native-preview-${sessionId}`,
    recentMessages: [
      { role: 'user', text: `user-${sessionId}` },
      { role: 'assistant', text: `assistant-${sessionId}` },
    ],
    gitBranch: 'main',
    isSidechain: false,
    ...overrides,
  };
}

function makeImportedSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: overrides.id ?? 'session-imported-current',
    sdkSessionId: overrides.sdkSessionId ?? 'native-current',
    source: 'claude-native',
    sourcePath: overrides.sourcePath ?? 'C:\\history\\native-current.jsonl',
    importedAt: overrides.importedAt ?? NOW_ISO,
    lastNativeActivityAt: overrides.lastNativeActivityAt ?? NOW_ISO,
    nativePreview: overrides.nativePreview ?? 'native preview',
    workingDirectory: overrides.workingDirectory ?? 'C:\\repo',
    createdAt: overrides.createdAt ?? NOW_ISO,
  };
}

function makeRegularSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: overrides.id ?? 'session-regular',
    workingDirectory: overrides.workingDirectory ?? 'C:\\repo',
    createdAt: overrides.createdAt ?? NOW_ISO,
    sdkSessionId: overrides.sdkSessionId,
    source: overrides.source,
    sourcePath: overrides.sourcePath,
    importedAt: overrides.importedAt,
    lastNativeActivityAt: overrides.lastNativeActivityAt,
    nativePreview: overrides.nativePreview,
    model: overrides.model,
    mode: overrides.mode,
  };
}

function makeMessage(text: string, channelType = CHANNEL_TYPE) {
  return {
    channelType,
    chatId: CHAT_ID,
    userId: USER_ID,
    messageId: `msg-${Math.random().toString(36).slice(2, 8)}`,
    text,
  };
}

function lastSend(adapter: BaseChannelAdapter) {
  return vi.mocked(adapter.send).mock.calls.at(-1)?.[0];
}

function createTempDir(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'command-router-native-'));
  TEMP_DIRS.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const TEMP_DIRS: string[] = [];

function createHarness(options: {
  channelType?: string;
  scanNativeSessions?: () => Promise<ClaudeNativeSessionCandidate[]>;
  findNativeSessionById?: (sessionId: string) => Promise<ClaudeNativeSessionCandidate | null>;
  isChatActive?: (channelType: string, chatId: string) => boolean;
  onNewSession?: (channelType: string, chatId: string) => void;
  activeControls?: Map<string, { interrupt(): Promise<void> }>;
} = {}) {
  const store = new MemoryStore();
  const state = new SessionStateManager();
  const adapter = mockAdapter(options.channelType ?? CHANNEL_TYPE);
  const candidateCache = new NativeCommandCandidateCache();
  const leaseService = new NativeSessionLeaseService(store);
  const permissions = { clearSessionWhitelist: vi.fn() };

  initBridgeContext({
    defaultWorkdir: 'C:\\repo',
    store,
    llm: {
      streamChat: vi.fn(),
      capabilities: vi.fn(() => ({
        slashCommands: true,
        askUserQuestion: true,
        liveSession: true,
        todoTracking: true,
        costInUsd: true,
        skills: true,
        sessionResume: true,
      })),
    } as any,
    permissions: {} as any,
    core: { isHealthy: () => true } as any,
  });

  const commandRouter = new CommandRouter(
    state,
    () => new Map(),
    new ChannelRouter(),
    () => true,
    (options.activeControls as any) ?? new Map(),
    permissions,
    options.onNewSession,
    {
      isChatActive: options.isChatActive,
      scanNativeSessions: options.scanNativeSessions,
      findNativeSessionById: options.findNativeSessionById,
      leaseService,
      candidateCache,
    },
  );

  return {
    adapter,
    candidateCache,
    commandRouter,
    leaseService,
    permissions,
    state,
    store,
  };
}

async function bindCurrentImportedSession(store: MemoryStore, session: SessionData): Promise<void> {
  await store.saveSession(session);
  await store.saveBinding({
    channelType: CHANNEL_TYPE,
    chatId: CHAT_ID,
    sessionId: session.id,
    createdAt: NOW_ISO,
  });
}

async function saveLease(
  store: MemoryStore,
  sdkSessionId: string,
  tliveSessionId: string,
  owner = nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID),
  lastActiveAt = '2026-05-06T11:30:00.000Z',
): Promise<void> {
  await store.saveNativeSessionLease({
    sdkSessionId,
    owner,
    ownerUserId: USER_ID,
    tliveSessionId,
    lockedAt: '2026-05-06T11:00:00.000Z',
    lastActiveAt,
    ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CommandRouter native Claude commands', () => {
  it('shows unavailable cwd instead of default workdir for unknown-cwd /session results', async () => {
    const candidate = makeCandidate('native-display', {
      sourcePath: 'C:\\history\\native-display.jsonl',
      cwd: undefined,
      cwdSource: 'unknown',
      cwdExists: false,
      gitBranch: undefined,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('cwd unavailable');
    expect(html).not.toContain('native-display.jsonl');
    expect(html).not.toContain('C:\\history');
    expect(html).not.toContain('native-display</code>');
    expect(html).not.toContain('C:\\repo');
  });

  it('uses an existing imported session working directory as the /session resume path', async () => {
    const importedCwd = createTempDir('existing imported cwd');
    const imported = makeImportedSession({
      sdkSessionId: 'native-existing-display',
      workingDirectory: importedCwd,
    });
    const candidate = makeCandidate('native-existing-display', {
      sourcePath: 'C:\\history\\native-existing-display.jsonl',
      cwd: 'D:\\old-worktree\\repo',
      cwdSource: 'jsonl',
      cwdExists: true,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });
    await harness.store.saveSession(imported);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain(importedCwd);
    expect(html).not.toContain('D:\\old-worktree\\repo');
    expect(html).not.toContain('native-existing-display.jsonl');
  });

  it('formats /session results and caches candidates', async () => {
    const importedCwd = createTempDir('format stable cwd');
    const imported = makeImportedSession({ sdkSessionId: 'native-1', workingDirectory: importedCwd });
    const candidate = makeCandidate('native-1', {
      sourcePath: 'C:\\history\\native-1.jsonl',
      cwd: undefined,
      cwdSource: 'unknown',
      cwdExists: false,
      gitBranch: 'feature/native',
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });
    await bindCurrentImportedSession(harness.store, imported);
    const previousActivity = new Date(Date.now() - 60_000).toISOString();
    await saveLease(harness.store, 'native-1', imported.id, nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID), previousActivity);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('📋 Claude Code history sessions');
    expect(html).not.toContain('🟣 Claude Code history sessions');
    expect(html).toContain('🔒 yours');
    expect(html).not.toContain('⚠️ cwd unknown');
    expect(html).toContain(`📁 <code>${importedCwd}</code>`);
    expect(html).toContain('💬 native-preview-native-1');
    expect(html).not.toContain('locked by you');
    expect(html).not.toContain('branch feature/native');
    expect(html).not.toContain('C:\\history\\native-1.jsonl');
    expect(html).not.toContain('imported');
    expect(html).toContain('🌿 feature/native');
    expect(html).toContain('/resume &lt;n&gt;');
    expect(html.indexOf('🔒 yours')).toBeLessThan(html.indexOf('🌿 feature/native'));
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toEqual([candidate]);
  });

  it('shows only five native sessions by default and caches those five', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => makeCandidate(`native-limit-${index + 1}`, {
      cwd: `C:\\repo-${index + 1}`,
      nativePreview: `preview-${index + 1}`,
    }));
    const harness = createHarness({
      scanNativeSessions: async () => candidates,
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('preview-1');
    expect(html).toContain('preview-5');
    expect(html).toContain('💬 preview-1\n\n2. 🕒');
    expect(html).not.toContain('preview-6');
    expect(html).toContain('Showing 5 of 7');
    expect(html).toContain('/session all');
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toEqual(candidates.slice(0, 5));
  });

  it('shows and caches all native sessions when /session all is used', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => makeCandidate(`native-all-${index + 1}`, {
      cwd: `C:\\repo-all-${index + 1}`,
      nativePreview: `all-preview-${index + 1}`,
    }));
    const harness = createHarness({
      scanNativeSessions: async () => candidates,
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session all'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('all-preview-1');
    expect(html).toContain('all-preview-7');
    expect(html).not.toContain('Showing 5 of 7');
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toEqual(candidates);
  });

  it('rejects native Claude commands outside Telegram', async () => {
    const harness = createHarness({ channelType: 'discord' });

    for (const text of ['/claude-sessions', '/cs', '/resume-claude 1', '/resume current', '/release']) {
      vi.mocked(harness.adapter.send).mockClear();
      const handled = await harness.commandRouter.handle(harness.adapter, makeMessage(text, 'discord'));
      expect(handled).toBe(true);
      expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('Telegram');
    }
  });

  it('requires cached candidates before numeric /resume', async () => {
    const harness = createHarness();

    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('/session');
  });

  it('resumes a numeric cached candidate from the Telegram-compatible /resume alias', async () => {
    const cwd = createTempDir('resume-underscore-target');
    const candidate = makeCandidate('native-underscore', { cwd, cwdExists: true });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();

    const handled = await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    expect(handled).toBe(true);
    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === 'native-underscore');
    expect(resumed).toBeTruthy();
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).toBe(resumed?.id);
    expect(await harness.leaseService.getActive('native-underscore')).toEqual(
      expect.objectContaining({ owner: nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID) }),
    );
  });

  it('resumes a numeric cached candidate, rebinds the chat, switches runtime to Claude, and moves the lease', async () => {
    const current = makeImportedSession({ id: 'session-imported-a', sdkSessionId: 'native-a' });
    const cwd = createTempDir('resume-target');
    const candidate = makeCandidate('native-b', {
      cwd,
      cwdExists: true,
      recentMessages: [
        { role: 'user', text: 'Open the repo status' },
        { role: 'assistant', text: 'Checking the working tree now.' },
      ],
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });
    await bindCurrentImportedSession(harness.store, current);
    await saveLease(harness.store, 'native-a', current.id);
    harness.state.setRuntime(CHANNEL_TYPE, CHAT_ID, 'codex');
    harness.state.setPermMode(CHANNEL_TYPE, CHAT_ID, 'off');

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();

    const handled = await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    expect(handled).toBe(true);
    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === 'native-b');
    expect(resumed).toBeTruthy();
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).toBe(resumed?.id);
    expect(await harness.leaseService.getActive('native-b')).toEqual(
      expect.objectContaining({ owner: nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID) }),
    );
    expect(await harness.leaseService.getActive('native-a')).toBeNull();
    expect(harness.state.getRuntime(CHANNEL_TYPE, CHAT_ID)).toBe('claude');
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toBeNull();
    const successHtml = String(vi.mocked(harness.adapter.send).mock.calls[0]?.[0]?.html ?? '');
    expect(successHtml).toContain('🔄 <b>Claude session resumed</b>');
    expect(successHtml).not.toContain('🟣 <b>Claude native session resumed</b>');
    expect(successHtml).not.toContain('<b>Session:</b>');
    expect(successHtml).not.toContain('<b>TLive session:</b>');
    expect(successHtml).toContain(`📁 <code>${cwd}</code>`);
    expect(successHtml).toContain('🌿 <code>main</code>');
    expect(successHtml).toContain('🕒 Lease: 30 min');
    expect(successHtml).toContain('💻 <code>claude --resume native-b</code>');
    expect(successHtml).toContain('Use <code>/release</code> when done.');
    expect(successHtml).toContain('🤖 Model: default');
    expect(successHtml).toContain('🧠 Effort: xhigh');
    expect(successHtml).toContain('🔐 Perm: off');
    expect(successHtml).toContain('Runtime: switched to Claude');
    expect(String(vi.mocked(harness.adapter.send).mock.calls[1]?.[0]?.html ?? '')).toContain('Recent context');
  });

  it('rejects /resume while the chat is running before importing or rebinding', async () => {
    const candidate = makeCandidate('native-running', { cwd: createTempDir('running-target') });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
      isChatActive: () => true,
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('/stop');
    expect((await harness.store.listSessions()).some(session => session.sdkSessionId === 'native-running')).toBe(false);
    expect(await harness.leaseService.getActive('native-running')).toBeNull();
  });

  it('resumes an exact native session id via finder without requiring the candidate cache', async () => {
    const candidate = makeCandidate('1234567890abcdef', { cwd: createTempDir('exact-id-target') });
    const findNativeSessionById = vi.fn(async (sessionId: string) => sessionId === candidate.sessionId ? candidate : null);
    const harness = createHarness({ findNativeSessionById });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1234567890abcdef'));

    expect(findNativeSessionById).toHaveBeenCalledWith('1234567890abcdef');
    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === '1234567890abcdef');
    expect(resumed).toBeTruthy();
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).toBe(resumed?.id);
    const html = String(vi.mocked(harness.adapter.send).mock.calls[0]?.[0]?.html ?? '');
    expect(html).not.toContain('TLive session');
    expect(html).toContain('claude --resume 1234567890abcdef');
  });
  it('reuses an existing imported session for the same sdkSessionId', async () => {
    const candidate = makeCandidate('native-existing', { cwd: createTempDir('existing-sdk') });
    const existingCwd = createTempDir('existing-imported-sdk');
    const existing = makeImportedSession({
      id: 'session-imported-existing',
      sdkSessionId: 'native-existing',
      workingDirectory: existingCwd,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });
    await harness.store.saveSession(existing);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    const rebound = await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID);
    const session = await harness.store.getSession(existing.id);
    expect(rebound?.sessionId).toBe(existing.id);
    expect(session?.workingDirectory).toBe(existing.workingDirectory);
  });

  it('rejects resuming a candidate with no cwd unless cwd is supplied', async () => {
    const candidate = makeCandidate('native-default-cwd', {
      cwd: undefined,
      cwdSource: 'unknown',
      cwdExists: false,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === 'native-default-cwd');
    expect(resumed).toBeUndefined();
    expect(await harness.leaseService.getActive('native-default-cwd')).toBeNull();
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('cwd is unavailable');
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('/resume 1 cwd "');
  });

  it('rejects resuming a candidate whose cwd path is missing unless cwd is supplied', async () => {
    const candidate = makeCandidate('native-missing', {
      cwd: 'C:\\missing-path',
      cwdExists: false,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === 'native-missing');
    expect(resumed).toBeUndefined();
    expect(await harness.leaseService.getActive('native-missing')).toBeNull();
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('cwd path is missing');
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('/resume 1 cwd "');
  });

  it('resumes an unknown-cwd candidate when an existing imported cwd is valid', async () => {
    const importedCwd = createTempDir('valid imported resume cwd');
    const existing = makeImportedSession({
      id: 'session-imported-valid-cwd',
      sdkSessionId: 'native-valid-imported-cwd',
      workingDirectory: importedCwd,
    });
    const candidate = makeCandidate('native-valid-imported-cwd', {
      cwd: undefined,
      cwdSource: 'unknown',
      cwdExists: false,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });
    await harness.store.saveSession(existing);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(harness.adapter, makeMessage('/resume 1'));

    const resumed = await harness.store.getSession(existing.id);
    expect(resumed?.workingDirectory).toBe(importedCwd);
    expect(await harness.leaseService.getActive('native-valid-imported-cwd')).toEqual(
      expect.objectContaining({ owner: nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID) }),
    );
  });

  it('accepts a quoted absolute cwd override with spaces and updates the imported session cwd', async () => {
    const overrideDir = createTempDir('project with spaces');
    const candidate = makeCandidate('native-override', {
      cwd: 'C:\\missing-path',
      cwdExists: false,
    });
    const harness = createHarness({
      scanNativeSessions: async () => [candidate],
    });

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session'));
    vi.mocked(harness.adapter.send).mockClear();
    await harness.commandRouter.handle(
      harness.adapter,
      makeMessage(`/resume 1 cwd "${overrideDir}"`),
    );

    const resumed = (await harness.store.listSessions()).find(session => session.sdkSessionId === 'native-override');
    expect(resumed?.workingDirectory).toBe(overrideDir);
    expect(String(vi.mocked(harness.adapter.send).mock.calls[0]?.[0]?.html ?? '')).toContain(overrideDir);
  });

  it('resumes /resume current from the current imported binding without cache and honors cwd', async () => {
    const overrideDir = createTempDir('current resume');
    const current = makeImportedSession({
      id: 'session-imported-current',
      sdkSessionId: 'native-current',
      workingDirectory: 'C:\\old-current',
    });
    const harness = createHarness({
      findNativeSessionById: async () => null,
    });
    await bindCurrentImportedSession(harness.store, current);

    await harness.commandRouter.handle(
      harness.adapter,
      makeMessage(`/resume current cwd "${overrideDir}"`),
    );

    expect((await harness.store.getSession(current.id))?.workingDirectory).toBe(overrideDir);
    expect(await harness.leaseService.getActive('native-current')).toEqual(
      expect.objectContaining({ owner: nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID) }),
    );
    expect(String(vi.mocked(harness.adapter.send).mock.calls[1]?.[0]?.html ?? '')).toContain('No recent visible context');
  });

  it('releases the current native lease, closes the live session, keeps the binding, and shows desktop guidance', async () => {
    const onNewSession = vi.fn();
    const current = makeImportedSession({ id: 'session-imported-release', sdkSessionId: 'native-release' });
    const harness = createHarness({ onNewSession });
    await bindCurrentImportedSession(harness.store, current);
    await saveLease(harness.store, 'native-release', current.id);
    harness.candidateCache.set(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID), [makeCandidate('native-release')]);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/release'));

    expect(onNewSession).toHaveBeenCalledWith(CHANNEL_TYPE, CHAT_ID);
    expect(await harness.leaseService.getActive('native-release')).toBeNull();
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).toBe(current.id);
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toBeNull();
    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('claude --resume native-release');
    expect(html.toLowerCase()).toContain('desktop');
  });

  it('rejects /release, /new, and /runtime codex while the chat is running', async () => {
    const harness = createHarness({
      isChatActive: () => true,
    });

    for (const text of ['/release', '/new', '/runtime codex']) {
      vi.mocked(harness.adapter.send).mockClear();
      await harness.commandRouter.handle(harness.adapter, makeMessage(text));
      const sentText = String(lastSend(harness.adapter)?.text ?? '');
      expect(sentText).toContain('/stop');
      if (text === '/runtime codex') {
        expect(sentText).not.toContain('not installed');
      }
    }
  });

  it('auto-releases the current native lease on /new when the chat is idle', async () => {
    const onNewSession = vi.fn();
    const current = makeImportedSession({ id: 'session-imported-new', sdkSessionId: 'native-new' });
    const harness = createHarness({ onNewSession });
    await bindCurrentImportedSession(harness.store, current);
    await saveLease(harness.store, 'native-new', current.id);
    harness.candidateCache.set(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID), [makeCandidate('native-new')]);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/new'));

    expect(onNewSession).toHaveBeenCalledWith(CHANNEL_TYPE, CHAT_ID);
    expect(await harness.leaseService.getActive('native-new')).toBeNull();
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toBeNull();
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).not.toBe(current.id);
    expect(harness.permissions.clearSessionWhitelist).toHaveBeenCalled();
  });

  it('does not switch old TLive sessions through /session numbers', async () => {
    const current = makeImportedSession({
      id: 'session-imported-session-switch',
      sdkSessionId: 'native-session-switch',
      createdAt: '2026-05-05T12:00:00.000Z',
    });
    const target = makeRegularSession({
      id: 'session-target',
      createdAt: '2026-05-06T12:30:00.000Z',
    });
    const harness = createHarness();
    await bindCurrentImportedSession(harness.store, current);
    await harness.store.saveSession(target);
    const previousActivity = new Date(Date.now() - 60_000).toISOString();
    await saveLease(harness.store, 'native-session-switch', current.id, nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID), previousActivity);
    const cachedCandidate = makeCandidate('native-session-switch');
    harness.candidateCache.set(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID), [cachedCandidate]);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/session 1'));

    expect(await harness.leaseService.getActive('native-session-switch')).toBeTruthy();
    expect(harness.candidateCache.get(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID))).toEqual([cachedCandidate]);
    expect((await harness.store.getBinding(CHANNEL_TYPE, CHAT_ID))?.sessionId).toBe(current.id);
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('Usage: /resume <n|current>');
  });

  it('refreshes but does not release the current native lease on /stop', async () => {
    const current = makeImportedSession({ id: 'session-imported-stop', sdkSessionId: 'native-stop' });
    const harness = createHarness();
    await bindCurrentImportedSession(harness.store, current);
    const previousActivity = new Date(Date.now() - 60_000).toISOString();
    await saveLease(harness.store, 'native-stop', current.id, nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID), previousActivity);

    await harness.commandRouter.handle(harness.adapter, makeMessage('/stop'));

    const lease = await harness.leaseService.getActive('native-stop');
    expect(lease).toBeTruthy();
    expect(lease?.lastActiveAt).not.toBe(previousActivity);
    expect(String(lastSend(harness.adapter)?.text ?? '')).toContain('No active execution');
  });

  it('prompts Telegram users to use /session for removed native session list aliases', async () => {
    const harness = createHarness();

    for (const text of ['/sessions', '/claude-sessions', '/claude_sessions', '/cs']) {
      vi.mocked(harness.adapter.send).mockClear();
      const handled = await harness.commandRouter.handle(harness.adapter, makeMessage(text));

      expect(handled).toBe(true);
      expect(String(lastSend(harness.adapter)?.text ?? '')).toBe('Use /session');
    }
  });

  it('prompts Telegram users to use /resume for removed native resume aliases', async () => {
    const harness = createHarness();

    for (const text of ['/resume-claude 1', '/resume_claude 1', '/rc current']) {
      vi.mocked(harness.adapter.send).mockClear();
      const handled = await harness.commandRouter.handle(harness.adapter, makeMessage(text));

      expect(handled).toBe(true);
      expect(String(lastSend(harness.adapter)?.text ?? '')).toBe('Use /resume');
    }
  });

  it('includes only /session, /resume, and /release native Claude commands in Telegram /help', async () => {
    const harness = createHarness();

    await harness.commandRouter.handle(harness.adapter, makeMessage('/help'));

    const html = String(lastSend(harness.adapter)?.html ?? '');
    expect(html).toContain('/session');
    expect(html).toContain('/resume &lt;n|current&gt;');
    expect(html).toContain('/release');
    expect(html).not.toContain('/sessions');
    expect(html).not.toContain('/claude-sessions');
    expect(html).not.toContain('/claude_sessions');
    expect(html).not.toContain('/cs');
    expect(html).not.toContain('/resume-claude');
    expect(html).not.toContain('/resume_claude');
    expect(html).not.toContain('/rc');
  });
});
