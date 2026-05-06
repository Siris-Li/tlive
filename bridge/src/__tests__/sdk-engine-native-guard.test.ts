import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import { initBridgeContext } from '../context.js';
import { SDKEngine } from '../engine/sdk-engine.js';
import { ChannelRouter } from '../engine/router.js';
import { SessionStateManager } from '../engine/session-state.js';
import type { CanonicalEvent } from '../messages/schema.js';
import type { LLMProvider, LiveSession, ProviderCapabilities, StreamChatResult } from '../providers/base.js';
import { NATIVE_LEASE_TTL_MINUTES, nativeLeaseOwner } from '../native/native-session-lease.js';
import type { BridgeStore, ChannelBinding, Message, NativeSessionLease, SessionData } from '../store/interface.js';

const CHANNEL_TYPE = 'telegram';
const CHAT_ID = 'chat-1234';
const USER_ID = 'user-1';
const SESSION_ID = 'session-imported';
const SDK_SESSION_ID = 'native-session-1';
const NOW_ISO = '2026-05-06T12:00:00.000Z';
const OLD_ISO = '2026-05-06T11:50:00.000Z';

const CAPABILITIES: ProviderCapabilities = {
  slashCommands: true,
  askUserQuestion: true,
  liveSession: false,
  todoTracking: true,
  costInUsd: true,
  skills: true,
  sessionResume: true,
};

class MemoryStore implements BridgeStore {
  private readonly sessions = new Map<string, SessionData>();
  private readonly messages = new Map<string, Message[]>();
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly leases = new Map<string, NativeSessionLease>();
  private readonly processed = new Set<string>();

  readonly getSession = vi.fn(async (id: string): Promise<SessionData | null> => {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  });

  readonly saveSession = vi.fn(async (session: SessionData): Promise<void> => {
    this.sessions.set(session.id, { ...session });
  });

  readonly listSessions = vi.fn(async (): Promise<SessionData[]> => {
    return Array.from(this.sessions.values()).map(session => ({ ...session }));
  });

  readonly deleteSession = vi.fn(async (id: string): Promise<void> => {
    this.sessions.delete(id);
  });

  readonly getNativeSessionLease = vi.fn(async (sdkSessionId: string): Promise<NativeSessionLease | null> => {
    const lease = this.leases.get(sdkSessionId);
    return lease ? { ...lease } : null;
  });

  readonly saveNativeSessionLease = vi.fn(async (lease: NativeSessionLease): Promise<void> => {
    this.leases.set(lease.sdkSessionId, { ...lease });
  });

  readonly deleteNativeSessionLease = vi.fn(async (sdkSessionId: string): Promise<void> => {
    this.leases.delete(sdkSessionId);
  });

  readonly listNativeSessionLeases = vi.fn(async (): Promise<NativeSessionLease[]> => {
    return Array.from(this.leases.values()).map(lease => ({ ...lease }));
  });

  readonly getMessages = vi.fn(async (sessionId: string): Promise<Message[]> => {
    return (this.messages.get(sessionId) ?? []).map(message => ({ ...message }));
  });

  readonly saveMessage = vi.fn(async (sessionId: string, message: Message): Promise<void> => {
    const existing = this.messages.get(sessionId) ?? [];
    existing.push({ ...message });
    this.messages.set(sessionId, existing);
  });

  readonly getBinding = vi.fn(async (channelType: string, chatId: string): Promise<ChannelBinding | null> => {
    const binding = this.bindings.get(`${channelType}:${chatId}`);
    return binding ? { ...binding } : null;
  });

  readonly saveBinding = vi.fn(async (binding: ChannelBinding): Promise<void> => {
    this.bindings.set(`${binding.channelType}:${binding.chatId}`, { ...binding });
  });

  readonly deleteBinding = vi.fn(async (channelType: string, chatId: string): Promise<void> => {
    this.bindings.delete(`${channelType}:${chatId}`);
  });

  readonly listBindings = vi.fn(async (): Promise<ChannelBinding[]> => {
    return Array.from(this.bindings.values()).map(binding => ({ ...binding }));
  });

  readonly isDuplicate = vi.fn(async (messageId: string): Promise<boolean> => {
    return this.processed.has(messageId);
  });

  readonly markProcessed = vi.fn(async (messageId: string): Promise<void> => {
    this.processed.add(messageId);
  });

  readonly acquireLock = vi.fn(async (): Promise<boolean> => true);
  readonly renewLock = vi.fn(async (): Promise<boolean> => true);
  readonly releaseLock = vi.fn(async (): Promise<void> => {});
}

function mockAdapter(): BaseChannelAdapter {
  return {
    channelType: CHANNEL_TYPE,
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

function mockPermissions() {
  const gateway = {
    isPending: vi.fn().mockReturnValue(false),
    waitFor: vi.fn(),
  };
  return {
    getGateway: vi.fn(() => gateway),
    isToolAllowed: vi.fn().mockReturnValue(false),
    setPendingSdkPerm: vi.fn(),
    clearPendingSdkPerm: vi.fn(),
    storeQuestionData: vi.fn(),
    trackPermissionMessage: vi.fn(),
    clearSessionWhitelist: vi.fn(),
  } as any;
}

function makeMessage(text = 'hello'): InboundMessage {
  return {
    channelType: CHANNEL_TYPE,
    chatId: CHAT_ID,
    userId: USER_ID,
    messageId: 'msg-1',
    text,
  };
}

function makeImportedSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: SESSION_ID,
    sdkSessionId: SDK_SESSION_ID,
    source: 'claude-native',
    sourcePath: 'C:\\history\\native-session-1.jsonl',
    importedAt: OLD_ISO,
    lastNativeActivityAt: OLD_ISO,
    nativePreview: 'native preview',
    workingDirectory: 'C:\\repo',
    createdAt: OLD_ISO,
    ...overrides,
  };
}

function makeRegularSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-regular',
    sdkSessionId: 'regular-sdk-session',
    workingDirectory: 'C:\\repo',
    createdAt: OLD_ISO,
    ...overrides,
  };
}

function streamFromEvents(events: CanonicalEvent[]): ReadableStream<CanonicalEvent> {
  return new ReadableStream<CanonicalEvent>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

function makeProvider(events: CanonicalEvent[] = [
  { kind: 'text_delta', text: 'reply' },
  { kind: 'query_result', sessionId: SDK_SESSION_ID, isError: false, usage: { inputTokens: 1, outputTokens: 1 } },
]): LLMProvider {
  return {
    streamChat: vi.fn((): StreamChatResult => ({
      stream: streamFromEvents(events),
      controls: undefined,
    })),
    capabilities: vi.fn(() => CAPABILITIES),
  };
}

function makeThrowingProvider(error = new Error('stream failed')): LLMProvider {
  return {
    streamChat: vi.fn((): StreamChatResult => ({
      stream: new ReadableStream<CanonicalEvent>({
        start(controller) {
          controller.error(error);
        },
      }),
      controls: undefined,
    })),
    capabilities: vi.fn(() => CAPABILITIES),
  };
}

function createHarness(provider: LLMProvider = makeProvider()) {
  const store = new MemoryStore();
  const state = new SessionStateManager();
  const adapter = mockAdapter();
  const permissions = mockPermissions();

  initBridgeContext({
    defaultWorkdir: 'C:\\repo',
    store,
    llm: provider,
    permissions: {} as any,
    core: { isHealthy: () => true } as any,
  });

  const engine = new SDKEngine(state, new ChannelRouter(), permissions);

  return { adapter, engine, provider, state, store };
}

async function bindSession(store: MemoryStore, session: SessionData): Promise<void> {
  await store.saveSession(session);
  await store.saveBinding({
    channelType: CHANNEL_TYPE,
    chatId: CHAT_ID,
    sessionId: session.id,
    createdAt: OLD_ISO,
  });
  store.saveSession.mockClear();
  store.saveBinding.mockClear();
}

async function saveLease(
  store: MemoryStore,
  sdkSessionId = SDK_SESSION_ID,
  owner = nativeLeaseOwner(CHANNEL_TYPE, CHAT_ID),
): Promise<void> {
  await store.saveNativeSessionLease({
    sdkSessionId,
    owner,
    ownerUserId: USER_ID,
    tliveSessionId: SESSION_ID,
    lockedAt: OLD_ISO,
    lastActiveAt: OLD_ISO,
    ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
  });
  store.saveNativeSessionLease.mockClear();
  store.deleteNativeSessionLease.mockClear();
}

function lastSentText(adapter: BaseChannelAdapter): string {
  const sent = vi.mocked(adapter.send).mock.calls.at(-1)?.[0];
  return String(sent?.text ?? sent?.html ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SDKEngine native imported session guard', () => {
  it('blocks ordinary messages to released imported native sessions before saving or typing', async () => {
    const harness = createHarness();
    await bindSession(harness.store, makeImportedSession());

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), harness.provider)).resolves.toBe(true);

    expect(lastSentText(harness.adapter)).toContain('/resume-claude current');
    expect(lastSentText(harness.adapter)).toContain('/rc current');
    expect(harness.store.saveMessage).not.toHaveBeenCalled();
    expect(harness.adapter.sendTyping).not.toHaveBeenCalled();
    expect(harness.adapter.addReaction).not.toHaveBeenCalled();
  });

  it('blocks ordinary messages when another owner owns the native lease', async () => {
    const harness = createHarness();
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store, SDK_SESSION_ID, 'telegram:chat-9999');

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), harness.provider)).resolves.toBe(true);

    expect(lastSentText(harness.adapter)).toContain('telegram:*9999');
    expect(harness.store.saveMessage).not.toHaveBeenCalled();
    expect(harness.adapter.sendTyping).not.toHaveBeenCalled();
    expect(harness.adapter.addReaction).not.toHaveBeenCalled();
  });

  it('refreshes a valid owner lease and proceeds with message processing', async () => {
    const harness = createHarness();
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), harness.provider)).resolves.toBe(true);

    expect(harness.store.saveMessage).toHaveBeenCalled();
    expect(harness.store.saveNativeSessionLease).toHaveBeenCalled();
    const finalLease = await harness.store.getNativeSessionLease(SDK_SESSION_ID);
    expect(finalLease?.lastActiveAt).toBe(NOW_ISO);
    expect(harness.store.saveNativeSessionLease.mock.calls.at(-1)?.[0].lastActiveAt).toBe(NOW_ISO);
  });

  it('reports a chat active when the processing flag is set', () => {
    const harness = createHarness();
    const chatKey = harness.state.stateKey(CHANNEL_TYPE, CHAT_ID);

    expect(harness.engine.isChatActive(CHANNEL_TYPE, CHAT_ID)).toBe(false);

    harness.state.setProcessing(chatKey, true);

    expect(harness.engine.isChatActive(CHANNEL_TYPE, CHAT_ID)).toBe(true);
  });

  it('reports a chat active when a managed LiveSession has an active turn', async () => {
    let controller: ReadableStreamDefaultController<CanonicalEvent> | undefined;
    let active = false;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const liveSession: LiveSession = {
      startTurn: vi.fn((): StreamChatResult => {
        active = true;
        return {
          stream: new ReadableStream<CanonicalEvent>({
            start(c) {
              controller = c;
              resolveStarted?.();
            },
          }),
          controls: undefined,
        };
      }),
      steerTurn: vi.fn(),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      get isAlive() { return true; },
      get isTurnActive() { return active; },
    };
    const provider: LLMProvider = {
      streamChat: vi.fn(),
      capabilities: vi.fn(() => ({ ...CAPABILITIES, liveSession: true })),
      createSession: vi.fn(() => liveSession),
    };
    const harness = createHarness(provider);
    await bindSession(harness.store, makeRegularSession());

    const turn = harness.engine.handleMessage(harness.adapter, makeMessage(), provider);
    await started;

    expect(harness.engine.isChatActive(CHANNEL_TYPE, CHAT_ID)).toBe(true);

    active = false;
    controller!.enqueue({ kind: 'query_result', sessionId: 'regular-sdk-session', isError: false, usage: { inputTokens: 0, outputTokens: 0 } });
    controller!.close();
    await turn;
  });

  it('releases the owned native lease when processing fails after takeover starts', async () => {
    const harness = createHarness(makeThrowingProvider());
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), harness.provider)).rejects.toThrow('stream failed');

    expect(harness.store.deleteNativeSessionLease).toHaveBeenCalledWith(SDK_SESSION_ID);
    await expect(harness.store.getNativeSessionLease(SDK_SESSION_ID)).resolves.toBeNull();
  });

  it('releases the owned native lease when LiveSession startTurn throws synchronously', async () => {
    const liveSession: LiveSession = {
      startTurn: vi.fn(() => {
        throw new Error('start turn failed');
      }),
      steerTurn: vi.fn(),
      interruptTurn: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      get isAlive() { return true; },
      get isTurnActive() { return false; },
    };
    const provider: LLMProvider = {
      streamChat: vi.fn(),
      capabilities: vi.fn(() => ({ ...CAPABILITIES, liveSession: true })),
      createSession: vi.fn(() => liveSession),
    };
    const harness = createHarness(provider);
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), provider)).rejects.toThrow('start turn failed');

    expect(harness.store.deleteNativeSessionLease).toHaveBeenCalledWith(SDK_SESSION_ID);
    await expect(harness.store.getNativeSessionLease(SDK_SESSION_ID)).resolves.toBeNull();
    expect(harness.adapter.addReaction).toHaveBeenCalledWith(CHAT_ID, 'msg-1', '😱');
  });

  it('blocks expired imported native sessions instead of rebinding to a new session', async () => {
    const harness = createHarness();
    await bindSession(harness.store, makeImportedSession());
    const chatKey = harness.state.stateKey(CHANNEL_TYPE, CHAT_ID);
    vi.setSystemTime(new Date('2026-05-06T11:00:00.000Z'));
    harness.state.checkAndUpdateLastActive(CHANNEL_TYPE, CHAT_ID);
    vi.setSystemTime(new Date(NOW_ISO));

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), harness.provider)).resolves.toBe(true);

    expect(lastSentText(harness.adapter)).toContain('/resume-claude current');
    expect(harness.store.saveBinding).not.toHaveBeenCalled();
    expect(harness.store.saveMessage).not.toHaveBeenCalled();
    expect(harness.state.stateKey(CHANNEL_TYPE, CHAT_ID)).toBe(chatKey);
  });

  it('heartbeat-refreshes the native lease during long active turns', async () => {
    let controller: ReadableStreamDefaultController<CanonicalEvent> | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const provider: LLMProvider = {
      streamChat: vi.fn((): StreamChatResult => ({
        stream: new ReadableStream<CanonicalEvent>({
          start(c) {
            controller = c;
            resolveStarted?.();
          },
        }),
        controls: undefined,
      })),
      capabilities: vi.fn(() => CAPABILITIES),
    };
    const harness = createHarness(provider);
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    const turn = harness.engine.handleMessage(harness.adapter, makeMessage(), provider);
    await started;
    harness.store.saveNativeSessionLease.mockClear();

    vi.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();

    expect(harness.store.saveNativeSessionLease).toHaveBeenCalledWith(expect.objectContaining({
      sdkSessionId: SDK_SESSION_ID,
      lastActiveAt: '2026-05-06T12:05:00.000Z',
    }));

    controller!.enqueue({ kind: 'query_result', sessionId: SDK_SESSION_ID, isError: false, usage: { inputTokens: 0, outputTokens: 0 } });
    controller!.close();
    await turn;
  });

  it('releases the owned native lease when query_result is marked as error', async () => {
    const provider = makeProvider([
      { kind: 'query_result', sessionId: SDK_SESSION_ID, isError: true, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const harness = createHarness(provider);
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), provider)).resolves.toBe(true);

    expect(harness.store.deleteNativeSessionLease).toHaveBeenCalledWith(SDK_SESSION_ID);
    await expect(harness.store.getNativeSessionLease(SDK_SESSION_ID)).resolves.toBeNull();
    expect(harness.adapter.addReaction).toHaveBeenCalledWith(CHAT_ID, 'msg-1', '😱');
  });

  it('releases the owned native lease when a canonical error event is received', async () => {
    const provider = makeProvider([
      { kind: 'error', message: 'canonical failure' },
    ]);
    const harness = createHarness(provider);
    await bindSession(harness.store, makeImportedSession());
    await saveLease(harness.store);

    await expect(harness.engine.handleMessage(harness.adapter, makeMessage(), provider)).resolves.toBe(true);

    expect(harness.store.deleteNativeSessionLease).toHaveBeenCalledWith(SDK_SESSION_ID);
    await expect(harness.store.getNativeSessionLease(SDK_SESSION_ID)).resolves.toBeNull();
    expect(harness.adapter.addReaction).toHaveBeenCalledWith(CHAT_ID, 'msg-1', '😱');
  });
});
