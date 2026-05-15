# Telegram Resume Native Claude Code Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Telegram commands that list, import, lease, resume, and release existing native Claude Code JSONL sessions through TLive without patching built artifacts or global installs.

**Architecture:** Keep native Claude Code history handling in focused source modules: a scanner for read-only JSONL discovery, a recent-context renderer for Telegram orientation pages, an importer for TLive session records, and a lease service for persisted soft ownership. `CommandRouter` orchestrates Telegram commands, while `SDKEngine` guards ordinary messages and preserves the existing Claude Agent SDK `resume` path.

**Tech Stack:** TypeScript ESM, Node.js built-ins (`fs`, `path`, `os`, `readline`), Vitest, existing TLive bridge store/router/session-state abstractions.

---

## File Structure

### New source files

- `bridge/src/native/claude-native-scanner.ts`
  - Reads native Claude Code JSONL files from an injectable projects directory.
  - Exports candidate types, `scanClaudeNativeSessions()`, and `findClaudeNativeSessionById()`.
  - Handles mtime prefiltering, streaming parse, cwd derivation, sidechain exclusion, deduplication, branch metadata, and list previews.

- `bridge/src/native/recent-context.ts`
  - Converts scanner-visible message records into Telegram-safe HTML pages.
  - Exports `selectRecentContextMessages()` and `renderRecentContextPages()`.
  - Enforces no truncation for selected content, long assistant skip notices, old-to-new order, page markers, and complete HTML tags per page.

- `bridge/src/native/native-session-lease.ts`
  - Wraps `BridgeStore` lease methods with TTL-aware acquire/refresh/release/list helpers.
  - Exports `NativeSessionLeaseService`, owner helpers, mask helpers, and constants.

- `bridge/src/native/claude-session-importer.ts`
  - Imports scanner candidates into `SessionData` and reuses existing imported sessions by native `sdkSessionId`.
  - Preserves `importedAt` on reuse and refreshes cwd/source/native activity metadata.

- `bridge/src/engine/native-command-cache.ts`
  - Stores `/session` candidate lists in memory by chat key for 5 minutes.
  - Keeps cache logic out of `CommandRouter` so command tests can inspect expiry behavior directly.

### Modified source files

- `bridge/src/store/interface.ts`
  - Extend `SessionData` with `source`, `sourcePath`, `importedAt`, `lastNativeActivityAt`, `nativePreview`.
  - Add `NativeSessionLease` type.
  - Add native lease methods to `BridgeStore`.

- `bridge/src/store/json-file.ts`
  - Persist native leases to `native-session-leases.json`.
  - Load leases at startup and add get/save/delete/list methods.

- `bridge/src/engine/conversation.ts`
  - Preserve extra `SessionData` fields when updating `sdkSessionId` from `query_result`.

- `bridge/src/engine/sdk-engine.ts`
  - Add `isChatActive(channelType, chatId)`.
  - Add `closeCurrentSessionForBinding(channelType, chatId)` or use existing `closeSession()` from command code with known cwd.
  - Guard ordinary messages to imported native sessions before typing, reactions, message save, or LiveSession creation.
  - Refresh valid leases when a message is accepted and when the task finishes.
  - Release the lease if Claude resume/start fails.

- `bridge/src/engine/command-router.ts`
  - Add `/session`, `/session all`, `/resume <n|current>`, and `/release`.
  - Add constructor dependencies for active-chat checks, session closing, candidate cache, scanner/importer/lease services if not instantiated internally.
  - Update `/new`, `/session`, `/runtime`, `/stop`, `/sessions`, and Telegram `/help` for native-session semantics.

- `bridge/src/engine/bridge-manager.ts`
  - Add native commands to `QUICK_COMMANDS`.
  - Pass `SDKEngine.isChatActive()` and close-session callbacks into `CommandRouter`.

- `README.md` and `README_CN.md`
  - Add a short command list for `/session`, `/session all`, `/resume <n|current>`, `/resume <n|current> cwd "<absolute path>"`, and `/release`.

### New tests

- `bridge/src/__tests__/claude-native-scanner.test.ts`
- `bridge/src/__tests__/recent-context.test.ts`
- `bridge/src/__tests__/native-session-lease.test.ts`
- `bridge/src/__tests__/claude-session-importer.test.ts`
- `bridge/src/__tests__/command-router-native-claude.test.ts`
- `bridge/src/__tests__/sdk-engine-native-guard.test.ts`

### Modified tests

- `bridge/src/__tests__/json-file-store.test.ts`
- `bridge/src/__tests__/conversation.test.ts`
- `bridge/src/__tests__/bridge-manager.test.ts`

---

## Task 1: Extend Store Types and JSON Persistence for Native Leases

**Files:**
- Modify: `bridge/src/store/interface.ts:1-48`
- Modify: `bridge/src/store/json-file.ts:1-212`
- Modify: `bridge/src/__tests__/json-file-store.test.ts:1-83`

- [ ] **Step 1: Write failing tests for native lease persistence**

Add imports and tests to `bridge/src/__tests__/json-file-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JsonFileStore } from '../store/json-file.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// keep existing tests, then add these inside describe('JsonFileStore', () => { ... })

  it('saves, retrieves, lists, and deletes native session leases', async () => {
    const lease = {
      sdkSessionId: 'native-12345678',
      owner: 'telegram:c1',
      ownerUserId: 'u1',
      tliveSessionId: 'session-imported-12345678-1700000000000',
      lockedAt: '2026-05-06T10:00:00.000Z',
      lastActiveAt: '2026-05-06T10:01:00.000Z',
      ttlMinutes: 30,
    };

    await store.saveNativeSessionLease(lease);

    expect(await store.getNativeSessionLease('native-12345678')).toEqual(lease);
    expect(await store.listNativeSessionLeases()).toEqual([lease]);

    await store.deleteNativeSessionLease('native-12345678');

    expect(await store.getNativeSessionLease('native-12345678')).toBeNull();
    expect(await store.listNativeSessionLeases()).toEqual([]);
  });

  it('persists native session leases across store instances', async () => {
    const lease = {
      sdkSessionId: 'native-abcdef12',
      owner: 'telegram:c2',
      ownerUserId: 'u2',
      tliveSessionId: 'session-imported-abcdef12-1700000000000',
      lockedAt: '2026-05-06T10:00:00.000Z',
      lastActiveAt: '2026-05-06T10:02:00.000Z',
      ttlMinutes: 30,
    };

    await store.saveNativeSessionLease(lease);

    const reloaded = new JsonFileStore(tmpDir);

    expect(await reloaded.getNativeSessionLease('native-abcdef12')).toEqual(lease);
  });
```

- [ ] **Step 2: Run the failing store test**

Run:

```bash
npm --prefix bridge test -- json-file-store
```

Expected: FAIL with TypeScript/runtime errors like `saveNativeSessionLease is not a function` or missing `BridgeStore` members.

- [ ] **Step 3: Extend store interfaces**

Update `bridge/src/store/interface.ts` to:

```ts
export interface SessionData {
  id: string;
  sdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  mode?: string;
  createdAt: string;
  source?: 'claude-native';
  sourcePath?: string;
  importedAt?: string;
  lastNativeActivityAt?: string;
  nativePreview?: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChannelBinding {
  channelType: string;
  chatId: string;
  sessionId: string;
  createdAt: string;
}

export interface NativeSessionLease {
  sdkSessionId: string;
  owner: string;
  ownerUserId?: string;
  tliveSessionId: string;
  lockedAt: string;
  lastActiveAt: string;
  ttlMinutes: number;
}

export interface BridgeStore {
  // Sessions
  getSession(id: string): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<void>;
  listSessions(): Promise<SessionData[]>;
  deleteSession(id: string): Promise<void>;

  // Messages
  getMessages(sessionId: string): Promise<Message[]>;
  saveMessage(sessionId: string, message: Message): Promise<void>;

  // Bindings
  getBinding(channelType: string, chatId: string): Promise<ChannelBinding | null>;
  saveBinding(binding: ChannelBinding): Promise<void>;
  deleteBinding(channelType: string, chatId: string): Promise<void>;
  listBindings(): Promise<ChannelBinding[]>;

  // Native Claude Code session leases
  getNativeSessionLease(sdkSessionId: string): Promise<NativeSessionLease | null>;
  saveNativeSessionLease(lease: NativeSessionLease): Promise<void>;
  deleteNativeSessionLease(sdkSessionId: string): Promise<void>;
  listNativeSessionLeases(): Promise<NativeSessionLease[]>;

  // Dedup
  isDuplicate(messageId: string): Promise<boolean>;
  markProcessed(messageId: string): Promise<void>;

  // Locks
  acquireLock(key: string, ttlMs: number): Promise<boolean>;
  renewLock(key: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
}
```

- [ ] **Step 4: Add JSON lease persistence**

Update `bridge/src/store/json-file.ts`:

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeStore, SessionData, Message, ChannelBinding, NativeSessionLease } from './interface.js';

export class JsonFileStore implements BridgeStore {
  private dataDir: string;
  private sessions = new Map<string, SessionData>();
  private messages = new Map<string, Message[]>(); // key: sessionId
  private bindings = new Map<string, ChannelBinding>(); // key: channelType:chatId
  private processedIds = new Set<string>();
  private locks = new Map<string, number>(); // key -> expiresAt timestamp
  private nativeSessionLeases = new Map<string, NativeSessionLease>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'sessions'), { recursive: true });
    mkdirSync(join(dataDir, 'messages'), { recursive: true });
    this.loadFromDisk();
  }

  // keep existing helpers

  private nativeSessionLeasesPath(): string {
    return join(this.dataDir, 'native-session-leases.json');
  }

  private loadFromDisk(): void {
    // keep existing bindings, processed, sessions, and messages loading

    const nativeSessionLeases = this.readJson<Record<string, NativeSessionLease>>(this.nativeSessionLeasesPath());
    if (nativeSessionLeases) {
      for (const [key, val] of Object.entries(nativeSessionLeases)) {
        this.nativeSessionLeases.set(key, val);
      }
    }
  }

  private persistNativeSessionLeases(): void {
    const obj: Record<string, NativeSessionLease> = {};
    for (const [key, val] of this.nativeSessionLeases.entries()) {
      obj[key] = val;
    }
    this.atomicWrite(this.nativeSessionLeasesPath(), obj);
  }

  async getNativeSessionLease(sdkSessionId: string): Promise<NativeSessionLease | null> {
    return this.nativeSessionLeases.get(sdkSessionId) ?? null;
  }

  async saveNativeSessionLease(lease: NativeSessionLease): Promise<void> {
    this.nativeSessionLeases.set(lease.sdkSessionId, lease);
    this.persistNativeSessionLeases();
  }

  async deleteNativeSessionLease(sdkSessionId: string): Promise<void> {
    this.nativeSessionLeases.delete(sdkSessionId);
    this.persistNativeSessionLeases();
  }

  async listNativeSessionLeases(): Promise<NativeSessionLease[]> {
    return [...this.nativeSessionLeases.values()];
  }
}
```

Keep the existing `loadFromDisk()` contents and add the lease-loading block at the end of that method rather than replacing the method body.

- [ ] **Step 5: Run the store tests**

Run:

```bash
npm --prefix bridge test -- json-file-store
```

Expected: PASS.

- [ ] **Step 6: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/store/interface.ts bridge/src/store/json-file.ts bridge/src/__tests__/json-file-store.test.ts
git commit -m "feat(bridge): persist native Claude session leases"
```

---

## Task 2: Add Native Lease Service

**Files:**
- Create: `bridge/src/native/native-session-lease.ts`
- Create: `bridge/src/__tests__/native-session-lease.test.ts`

- [ ] **Step 1: Write failing lease service tests**

Create `bridge/src/__tests__/native-session-lease.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BridgeStore, NativeSessionLease } from '../store/interface.js';
import { NativeSessionLeaseService, maskLeaseOwner, nativeLeaseOwner } from '../native/native-session-lease.js';

function mockStore(initial: NativeSessionLease[] = []): BridgeStore {
  const leases = new Map(initial.map(lease => [lease.sdkSessionId, lease]));
  return {
    getSession: vi.fn(), saveSession: vi.fn(), listSessions: vi.fn(), deleteSession: vi.fn(),
    getMessages: vi.fn(), saveMessage: vi.fn(),
    getBinding: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
    isDuplicate: vi.fn(), markProcessed: vi.fn(),
    acquireLock: vi.fn(), renewLock: vi.fn(), releaseLock: vi.fn(),
    getNativeSessionLease: vi.fn(async (id: string) => leases.get(id) ?? null),
    saveNativeSessionLease: vi.fn(async (lease: NativeSessionLease) => { leases.set(lease.sdkSessionId, lease); }),
    deleteNativeSessionLease: vi.fn(async (id: string) => { leases.delete(id); }),
    listNativeSessionLeases: vi.fn(async () => [...leases.values()]),
  } as BridgeStore;
}

describe('NativeSessionLeaseService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds and masks Telegram owners', () => {
    expect(nativeLeaseOwner('telegram', '123456789')).toBe('telegram:123456789');
    expect(maskLeaseOwner('telegram:123456789')).toBe('telegram:*6789');
    expect(maskLeaseOwner('telegram:42')).toBe('telegram:*42');
  });

  it('acquires a lease when none exists', async () => {
    const store = mockStore();
    const service = new NativeSessionLeaseService(store);

    const result = await service.acquire({
      sdkSessionId: 'native-12345678',
      owner: 'telegram:c1',
      ownerUserId: 'u1',
      tliveSessionId: 'session-imported-12345678-1',
    });

    expect(result.status).toBe('acquired');
    expect(await store.getNativeSessionLease('native-12345678')).toEqual({
      sdkSessionId: 'native-12345678',
      owner: 'telegram:c1',
      ownerUserId: 'u1',
      tliveSessionId: 'session-imported-12345678-1',
      lockedAt: '2026-05-06T10:00:00.000Z',
      lastActiveAt: '2026-05-06T10:00:00.000Z',
      ttlMinutes: 30,
    });
  });

  it('refreshes when the same owner reacquires', async () => {
    const store = mockStore([{ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1', lockedAt: '2026-05-06T09:55:00.000Z', lastActiveAt: '2026-05-06T09:55:00.000Z', ttlMinutes: 30 }]);
    const service = new NativeSessionLeaseService(store);

    vi.setSystemTime(new Date('2026-05-06T10:05:00.000Z'));
    const result = await service.acquire({ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1' });

    expect(result.status).toBe('refreshed');
    expect(result.lease?.lastActiveAt).toBe('2026-05-06T10:05:00.000Z');
  });

  it('rejects another owner while lease is active', async () => {
    const store = mockStore([{ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1', lockedAt: '2026-05-06T09:55:00.000Z', lastActiveAt: '2026-05-06T09:55:00.000Z', ttlMinutes: 30 }]);
    const service = new NativeSessionLeaseService(store);

    const result = await service.acquire({ sdkSessionId: 'native-1', owner: 'telegram:c2', ownerUserId: 'u2', tliveSessionId: 's2' });

    expect(result.status).toBe('blocked');
    expect(result.lease?.owner).toBe('telegram:c1');
  });

  it('cleans expired lease and acquires for a new owner', async () => {
    const store = mockStore([{ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1', lockedAt: '2026-05-06T09:00:00.000Z', lastActiveAt: '2026-05-06T09:00:00.000Z', ttlMinutes: 30 }]);
    const service = new NativeSessionLeaseService(store);

    const result = await service.acquire({ sdkSessionId: 'native-1', owner: 'telegram:c2', ownerUserId: 'u2', tliveSessionId: 's2' });

    expect(result.status).toBe('acquired');
    expect(store.deleteNativeSessionLease).toHaveBeenCalledWith('native-1');
    expect(result.lease?.owner).toBe('telegram:c2');
  });

  it('refreshes only active leases owned by the caller', async () => {
    const store = mockStore([{ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1', lockedAt: '2026-05-06T09:55:00.000Z', lastActiveAt: '2026-05-06T09:55:00.000Z', ttlMinutes: 30 }]);
    const service = new NativeSessionLeaseService(store);

    const refreshed = await service.refresh('native-1', 'telegram:c1');
    const blocked = await service.refresh('native-1', 'telegram:c2');

    expect(refreshed.status).toBe('refreshed');
    expect(blocked.status).toBe('blocked');
  });

  it('reports expired release and deletes the lease', async () => {
    const store = mockStore([{ sdkSessionId: 'native-1', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 's1', lockedAt: '2026-05-06T09:00:00.000Z', lastActiveAt: '2026-05-06T09:00:00.000Z', ttlMinutes: 30 }]);
    const service = new NativeSessionLeaseService(store);

    const result = await service.release('native-1', 'telegram:c1');

    expect(result.status).toBe('expired');
    expect(store.deleteNativeSessionLease).toHaveBeenCalledWith('native-1');
  });
});
```

- [ ] **Step 2: Run the failing lease tests**

Run:

```bash
npm --prefix bridge test -- native-session-lease
```

Expected: FAIL because `../native/native-session-lease.js` does not exist.

- [ ] **Step 3: Implement the lease service**

Create `bridge/src/native/native-session-lease.ts`:

```ts
import type { BridgeStore, NativeSessionLease } from '../store/interface.js';

export const NATIVE_LEASE_TTL_MINUTES = 30;

export type LeaseAcquireStatus = 'acquired' | 'refreshed' | 'blocked';
export type LeaseRefreshStatus = 'refreshed' | 'missing' | 'expired' | 'blocked';
export type LeaseReleaseStatus = 'released' | 'missing' | 'expired' | 'blocked';

export interface LeaseResult<TStatus extends string> {
  status: TStatus;
  lease?: NativeSessionLease;
}

export interface AcquireNativeLeaseParams {
  sdkSessionId: string;
  owner: string;
  ownerUserId?: string;
  tliveSessionId: string;
}

export function nativeLeaseOwner(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

export function maskLeaseOwner(owner: string): string {
  const [channel, id = ''] = owner.split(':', 2);
  return `${channel}:*${id.slice(-4) || id}`;
}

export function isNativeLeaseExpired(lease: NativeSessionLease, now = Date.now()): boolean {
  return now - new Date(lease.lastActiveAt).getTime() >= lease.ttlMinutes * 60_000;
}

export class NativeSessionLeaseService {
  constructor(private store: BridgeStore) {}

  async cleanupExpired(now = Date.now()): Promise<number> {
    const leases = await this.store.listNativeSessionLeases();
    let cleaned = 0;
    for (const lease of leases) {
      if (isNativeLeaseExpired(lease, now)) {
        await this.store.deleteNativeSessionLease(lease.sdkSessionId);
        cleaned += 1;
      }
    }
    return cleaned;
  }

  async getActive(sdkSessionId: string, now = Date.now()): Promise<NativeSessionLease | null> {
    const lease = await this.store.getNativeSessionLease(sdkSessionId);
    if (!lease) return null;
    if (!isNativeLeaseExpired(lease, now)) return lease;
    await this.store.deleteNativeSessionLease(sdkSessionId);
    return null;
  }

  async acquire(params: AcquireNativeLeaseParams, now = Date.now()): Promise<LeaseResult<LeaseAcquireStatus>> {
    const existing = await this.store.getNativeSessionLease(params.sdkSessionId);
    if (existing && !isNativeLeaseExpired(existing, now) && existing.owner !== params.owner) {
      return { status: 'blocked', lease: existing };
    }

    if (existing && isNativeLeaseExpired(existing, now)) {
      await this.store.deleteNativeSessionLease(params.sdkSessionId);
    }

    const timestamp = new Date(now).toISOString();
    const lease: NativeSessionLease = {
      sdkSessionId: params.sdkSessionId,
      owner: params.owner,
      ownerUserId: params.ownerUserId,
      tliveSessionId: params.tliveSessionId,
      lockedAt: existing && existing.owner === params.owner && !isNativeLeaseExpired(existing, now) ? existing.lockedAt : timestamp,
      lastActiveAt: timestamp,
      ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
    };
    await this.store.saveNativeSessionLease(lease);
    return { status: existing && existing.owner === params.owner && !isNativeLeaseExpired(existing, now) ? 'refreshed' : 'acquired', lease };
  }

  async refresh(sdkSessionId: string, owner: string, now = Date.now()): Promise<LeaseResult<LeaseRefreshStatus>> {
    const existing = await this.store.getNativeSessionLease(sdkSessionId);
    if (!existing) return { status: 'missing' };
    if (isNativeLeaseExpired(existing, now)) {
      await this.store.deleteNativeSessionLease(sdkSessionId);
      return { status: 'expired', lease: existing };
    }
    if (existing.owner !== owner) return { status: 'blocked', lease: existing };

    const lease = { ...existing, lastActiveAt: new Date(now).toISOString() };
    await this.store.saveNativeSessionLease(lease);
    return { status: 'refreshed', lease };
  }

  async release(sdkSessionId: string, owner: string, now = Date.now()): Promise<LeaseResult<LeaseReleaseStatus>> {
    const existing = await this.store.getNativeSessionLease(sdkSessionId);
    if (!existing) return { status: 'missing' };
    if (existing.owner !== owner) return { status: 'blocked', lease: existing };

    await this.store.deleteNativeSessionLease(sdkSessionId);
    return { status: isNativeLeaseExpired(existing, now) ? 'expired' : 'released', lease: existing };
  }
}
```

- [ ] **Step 4: Run the lease tests**

Run:

```bash
npm --prefix bridge test -- native-session-lease
```

Expected: PASS.

- [ ] **Step 5: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/native/native-session-lease.ts bridge/src/__tests__/native-session-lease.test.ts
git commit -m "feat(bridge): add native session lease service"
```

---

## Task 3: Implement Native Claude JSONL Scanner

**Files:**
- Create: `bridge/src/native/claude-native-scanner.ts`
- Create: `bridge/src/__tests__/claude-native-scanner.test.ts`

- [ ] **Step 1: Write failing scanner tests**

Create `bridge/src/__tests__/claude-native-scanner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanClaudeNativeSessions, findClaudeNativeSessionById } from '../native/claude-native-scanner.js';

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

describe('claude-native-scanner', () => {
  let tmpDir: string;
  let cwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-native-scan-'));
    cwd = join(tmpDir, 'repo');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses session id, cwd, preview, timestamp, branch, and recent messages', async () => {
    const projectDir = join(tmpDir, 'D--Repo');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'native-11111111.jsonl');
    writeJsonl(file, [
      { type: 'user', sessionId: 'native-11111111', cwd, timestamp: '2026-05-06T09:00:00.000Z', gitBranch: 'main', message: { role: 'user', content: [{ type: 'text', text: 'first user' }] } },
      { type: 'assistant', sessionId: 'native-11111111', cwd, timestamp: '2026-05-06T09:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] } },
      { type: 'user', sessionId: 'native-11111111', cwd, timestamp: '2026-05-06T09:02:00.000Z', gitBranch: 'feature/native', message: { role: 'user', content: 'latest user' } },
    ]);

    const sessions = await scanClaudeNativeSessions({ baseDir: tmpDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'native-11111111',
      sourcePath: file,
      cwd,
      cwdSource: 'jsonl',
      cwdExists: true,
      lastActivityAt: '2026-05-06T09:02:00.000Z',
      preview: 'latest user',
      nativePreview: 'latest user',
      gitBranch: 'feature/native',
      isSidechain: false,
    });
    expect(sessions[0].recentMessages.map(m => `${m.role}:${m.text}`)).toEqual([
      'user:first user',
      'assistant:assistant reply',
      'user:latest user',
    ]);
  });

  it('derives cwd from project directory names and requires it to be a directory', async () => {
    const derived = join(tmpDir, 'D--SirisLi--GitHub--tlive');
    mkdirSync(derived, { recursive: true });
    const existingDerivedCwd = 'D:\\SirisLi\\GitHub\\tlive';
    const projectDir = join(tmpDir, 'D--SirisLi--GitHub--tlive');
    const file = join(projectDir, 'native-22222222.jsonl');
    writeJsonl(file, [
      { type: 'user', sessionId: 'native-22222222', timestamp: '2026-05-06T09:00:00.000Z', message: { role: 'user', content: 'hello' } },
    ]);

    const sessions = await scanClaudeNativeSessions({
      baseDir: tmpDir,
      limit: 10,
      cwdExists: path => path === existingDerivedCwd,
    });

    expect(sessions[0]).toMatchObject({ cwd: existingDerivedCwd, cwdSource: 'project-dir', cwdExists: true });
  });

  it('deduplicates by session id and keeps newest activity', async () => {
    const a = join(tmpDir, 'A');
    const b = join(tmpDir, 'B');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeJsonl(join(a, 'one.jsonl'), [{ type: 'user', sessionId: 'same-id', cwd, timestamp: '2026-05-06T09:00:00.000Z', message: { role: 'user', content: 'old' } }]);
    writeJsonl(join(b, 'two.jsonl'), [{ type: 'user', sessionId: 'same-id', cwd, timestamp: '2026-05-06T10:00:00.000Z', message: { role: 'user', content: 'new' } }]);

    const sessions = await scanClaudeNativeSessions({ baseDir: tmpDir, limit: 10 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].preview).toBe('new');
  });

  it('excludes sidechain sessions and tolerates malformed rows', async () => {
    const projectDir = join(tmpDir, 'Sidechain');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'side.jsonl'), [
      '{bad json',
      { type: 'user', sessionId: 'side-id', isSidechain: true, cwd, timestamp: '2026-05-06T09:00:00.000Z', message: { role: 'user', content: 'hidden' } },
    ]);

    const sessions = await scanClaudeNativeSessions({ baseDir: tmpDir, limit: 10 });

    expect(sessions).toEqual([]);
  });

  it('uses mtime only as prefilter and timestamp for final ordering', async () => {
    const projectDir = join(tmpDir, 'Order');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'older-mtime-newer-timestamp.jsonl'), [{ type: 'user', sessionId: 'newer', cwd, timestamp: '2026-05-06T11:00:00.000Z', message: { role: 'user', content: 'newer timestamp' } }]);
    writeJsonl(join(projectDir, 'newer-mtime-older-timestamp.jsonl'), [{ type: 'user', sessionId: 'older', cwd, timestamp: '2026-05-06T10:00:00.000Z', message: { role: 'user', content: 'older timestamp' } }]);

    const sessions = await scanClaudeNativeSessions({ baseDir: tmpDir, limit: 10 });

    expect(sessions.map(s => s.sessionId)).toEqual(['newer', 'older']);
  });

  it('finds a native session by id from recent JSONL files', async () => {
    const projectDir = join(tmpDir, 'Find');
    mkdirSync(projectDir, { recursive: true });
    writeJsonl(join(projectDir, 'native-33333333.jsonl'), [{ type: 'user', sessionId: 'native-33333333', cwd, timestamp: '2026-05-06T09:00:00.000Z', message: { role: 'user', content: 'found' } }]);

    const found = await findClaudeNativeSessionById('native-33333333', { baseDir: tmpDir });

    expect(found?.preview).toBe('found');
  });
});
```

- [ ] **Step 2: Run the failing scanner tests**

Run:

```bash
npm --prefix bridge test -- claude-native-scanner
```

Expected: FAIL because `../native/claude-native-scanner.js` does not exist.

- [ ] **Step 3: Implement scanner types and helpers**

Create `bridge/src/native/claude-native-scanner.ts` with these exports and constants:

```ts
import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

export const CLAUDE_JSONL_PREFILTER_LIMIT = 100;
export const CLAUDE_SESSION_LIST_LIMIT = 10;

export type NativeCwdSource = 'jsonl' | 'project-dir' | 'unknown';
export type NativeVisibleRole = 'user' | 'assistant';

export interface NativeVisibleMessage {
  role: NativeVisibleRole;
  text: string;
  timestamp?: string;
}

export interface ClaudeNativeSessionCandidate {
  sessionId: string;
  sourcePath: string;
  cwd?: string;
  cwdSource: NativeCwdSource;
  cwdExists: boolean;
  lastActivityAt: string;
  preview: string;
  nativePreview: string;
  recentMessages: NativeVisibleMessage[];
  gitBranch?: string;
  version?: string;
  isSidechain: boolean;
  filenameSessionId?: string;
  sessionIdMismatch?: boolean;
}

interface JsonlFileInfo {
  path: string;
  mtimeMs: number;
}

export interface ScanClaudeNativeSessionsOptions {
  baseDir?: string;
  prefilterLimit?: number;
  limit?: number;
  cwdExists?: (path: string) => boolean;
}

function defaultBaseDir(): string {
  return join(homedir(), '.claude', 'projects');
}

function defaultCwdExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement recursive JSONL discovery and cwd derivation**

Add:

```ts
function listJsonlFiles(dir: string): JsonlFileInfo[] {
  if (!existsSync(dir)) return [];
  const out: JsonlFileInfo[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          out.push({ path, mtimeMs: statSync(path).mtimeMs });
        } catch {}
      }
    }
  }
  return out;
}

function filenameSessionId(path: string): string | undefined {
  const name = basename(path, '.jsonl');
  return name || undefined;
}

function deriveCwdFromProjectDir(filePath: string): string | undefined {
  const encoded = basename(dirname(filePath));
  const driveMatch = encoded.match(/^([A-Za-z])--(.+)$/);
  if (!driveMatch) return undefined;
  const [, drive, rest] = driveMatch;
  return `${drive}:\\${rest.split('--').join('\\')}`;
}

function newerIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
```

- [ ] **Step 5: Implement visible-message extraction**

Add:

```ts
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const obj = part as Record<string, unknown>;
    if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text);
  }
  return parts.join('\n').trim();
}

function visibleMessageFromRow(row: Record<string, unknown>): NativeVisibleMessage | null {
  if (row.isMeta === true || row.isCompactSummary === true) return null;
  if (row.type === 'system') return null;
  if (row.toolUseResult !== undefined) return null;

  const message = row.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return null;

  const role = message.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const text = textFromContent(message.content).trim();
  if (text) return { role, text, timestamp: typeof row.timestamp === 'string' ? row.timestamp : undefined };

  if (role === 'user' && Array.isArray(message.content) && message.content.length > 0) {
    return { role, text: '[附件/图片消息，未在 Telegram 最近上下文中展开]', timestamp: typeof row.timestamp === 'string' ? row.timestamp : undefined };
  }

  return null;
}
```

- [ ] **Step 6: Implement file parsing and scanning**

Add:

```ts
async function parseCandidateFile(file: JsonlFileInfo, cwdExists: (path: string) => boolean): Promise<ClaudeNativeSessionCandidate | null> {
  const filenameId = filenameSessionId(file.path);
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let lastActivityAt: string | undefined;
  let firstVisibleUser: string | undefined;
  let latestVisibleUser: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let sidechainRows = 0;
  let usefulRows = 0;
  const recentMessages: NativeVisibleMessage[] = [];

  const rl = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!sessionId && typeof row.sessionId === 'string' && row.sessionId) sessionId = row.sessionId;
    if (typeof row.cwd === 'string' && row.cwd) cwd = row.cwd;
    if (typeof row.timestamp === 'string' && row.timestamp) lastActivityAt = newerIso(lastActivityAt, row.timestamp);
    if (typeof row.gitBranch === 'string' && row.gitBranch) gitBranch = row.gitBranch;
    if (typeof row.version === 'string' && row.version) version = row.version;
    if (row.isSidechain === true) sidechainRows += 1;

    const visible = visibleMessageFromRow(row);
    if (visible) {
      usefulRows += 1;
      recentMessages.push(visible);
      if (visible.role === 'user') {
        firstVisibleUser ??= visible.text;
        latestVisibleUser = visible.text;
      }
    }
  }

  sessionId ??= filenameId;
  if (!sessionId) return null;
  if (usefulRows === 0 && !lastActivityAt && !cwd) return null;

  const derivedCwd = cwd ? undefined : deriveCwdFromProjectDir(file.path);
  const finalCwd = cwd ?? derivedCwd;
  const cwdSource: NativeCwdSource = cwd ? 'jsonl' : derivedCwd ? 'project-dir' : 'unknown';
  const preview = latestVisibleUser ?? firstVisibleUser ?? '(empty)';
  const isSidechain = usefulRows > 0 && sidechainRows >= usefulRows;

  return {
    sessionId,
    sourcePath: file.path,
    cwd: finalCwd,
    cwdSource,
    cwdExists: finalCwd ? cwdExists(finalCwd) : false,
    lastActivityAt: lastActivityAt ?? new Date(file.mtimeMs).toISOString(),
    preview,
    nativePreview: preview,
    recentMessages,
    gitBranch,
    version,
    isSidechain,
    filenameSessionId: filenameId,
    sessionIdMismatch: !!filenameId && filenameId !== sessionId,
  };
}

function dedupeCandidates(candidates: ClaudeNativeSessionCandidate[]): ClaudeNativeSessionCandidate[] {
  const byId = new Map<string, ClaudeNativeSessionCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.sessionId);
    if (!existing) {
      byId.set(candidate.sessionId, candidate);
      continue;
    }
    const candidateTime = new Date(candidate.lastActivityAt).getTime();
    const existingTime = new Date(existing.lastActivityAt).getTime();
    if (candidateTime > existingTime || (candidateTime === existingTime && candidate.cwdExists && !existing.cwdExists)) {
      byId.set(candidate.sessionId, candidate);
    }
  }
  return [...byId.values()].sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
}

export async function scanClaudeNativeSessions(options: ScanClaudeNativeSessionsOptions = {}): Promise<ClaudeNativeSessionCandidate[]> {
  const baseDir = options.baseDir ?? defaultBaseDir();
  const prefilterLimit = options.prefilterLimit ?? CLAUDE_JSONL_PREFILTER_LIMIT;
  const limit = options.limit ?? CLAUDE_SESSION_LIST_LIMIT;
  const cwdExists = options.cwdExists ?? defaultCwdExists;

  const files = listJsonlFiles(baseDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, prefilterLimit);

  const candidates: ClaudeNativeSessionCandidate[] = [];
  for (const file of files) {
    try {
      const candidate = await parseCandidateFile(file, cwdExists);
      if (candidate && !candidate.isSidechain) candidates.push(candidate);
    } catch {}
  }

  return dedupeCandidates(candidates).slice(0, limit);
}

export async function findClaudeNativeSessionById(sessionId: string, options: ScanClaudeNativeSessionsOptions = {}): Promise<ClaudeNativeSessionCandidate | null> {
  const sessions = await scanClaudeNativeSessions({ ...options, limit: options.prefilterLimit ?? CLAUDE_JSONL_PREFILTER_LIMIT });
  return sessions.find(session => session.sessionId === sessionId) ?? null;
}
```

- [ ] **Step 7: Run scanner tests**

Run:

```bash
npm --prefix bridge test -- claude-native-scanner
```

Expected: PASS.

- [ ] **Step 8: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/native/claude-native-scanner.ts bridge/src/__tests__/claude-native-scanner.test.ts
git commit -m "feat(bridge): scan native Claude Code sessions"
```

---

## Task 4: Render Recent Context Pages Without Truncating Selected Messages

**Files:**
- Create: `bridge/src/native/recent-context.ts`
- Create: `bridge/src/__tests__/recent-context.test.ts`

- [ ] **Step 1: Write failing recent-context tests**

Create `bridge/src/__tests__/recent-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { NativeVisibleMessage } from '../native/claude-native-scanner.js';
import { renderRecentContextPages, selectRecentContextMessages } from '../native/recent-context.js';

function msg(role: 'user' | 'assistant', text: string): NativeVisibleMessage {
  return { role, text };
}

describe('recent-context', () => {
  it('shows latest 3 complete visible messages by default in old-to-new order', () => {
    const selected = selectRecentContextMessages([
      msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three'), msg('assistant', 'four'), msg('user', 'five'), msg('assistant', 'six long '.repeat(400)),
    ]);

    expect(selected.map(item => item.kind === 'message' ? item.message.text : item.text)).toEqual(['four', 'five', 'six long '.repeat(400)]);
  });

  it('expands to 5 messages when latest 3 are under 1500 characters', () => {
    const selected = selectRecentContextMessages([
      msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three'), msg('assistant', 'four'), msg('user', 'five'),
    ]);

    expect(selected).toHaveLength(5);
  });

  it('skips long assistant messages and keeps filling displayable messages', () => {
    const selected = selectRecentContextMessages([
      msg('user', 'one'), msg('assistant', 'two'), msg('assistant', 'A'.repeat(6001)), msg('user', 'three'), msg('assistant', 'four'),
    ]);

    expect(selected.map(item => item.kind)).toEqual(['message', 'message', 'skip', 'message', 'message']);
    expect(selected.filter(item => item.kind === 'message')).toHaveLength(4);
  });

  it('renders Telegram HTML with escaping and self-contained page tags', () => {
    const pages = renderRecentContextPages([
      msg('user', '<hello & goodbye>'),
      msg('assistant', 'ok'),
    ], { pageLimit: 4096 });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('<b>最近上下文</b>');
    expect(pages[0]).toContain('&lt;hello &amp; goodbye&gt;');
    expect(pages[0]).toContain('<pre>');
    expect(pages[0]).toContain('</pre>');
  });

  it('does not truncate long user messages and splits pages with markers', () => {
    const longText = 'U'.repeat(7000);
    const pages = renderRecentContextPages([msg('user', longText)], { pageLimit: 1200 });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('')).toContain('U'.repeat(7000));
    expect(pages[0]).toContain('(1/');
    expect(pages.at(-1)).toContain(`/${pages.length})`);
    for (const page of pages) {
      expect(page).toContain('<pre>');
      expect(page).toContain('</pre>');
    }
  });

  it('renders current mode with at most 3 messages', () => {
    const selected = selectRecentContextMessages([
      msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three'), msg('assistant', 'four'), msg('user', 'five'),
    ], { mode: 'current' });

    expect(selected.map(item => item.kind === 'message' ? item.message.text : item.text)).toEqual(['three', 'four', 'five']);
  });
});
```

- [ ] **Step 2: Run the failing recent-context tests**

Run:

```bash
npm --prefix bridge test -- recent-context
```

Expected: FAIL because `../native/recent-context.js` does not exist.

- [ ] **Step 3: Implement recent context selection and rendering**

Create `bridge/src/native/recent-context.ts`:

```ts
import type { NativeVisibleMessage } from './claude-native-scanner.js';

export const RECENT_CONTEXT_EXPAND_THRESHOLD = 1500;
export const LONG_ASSISTANT_SKIP_THRESHOLD = 6000;
export const TELEGRAM_SAFE_PAGE_LIMIT = 3900;

export type SelectedRecentContextItem =
  | { kind: 'message'; message: NativeVisibleMessage }
  | { kind: 'skip'; text: string };

export interface SelectRecentContextOptions {
  mode?: 'resume' | 'current';
}

export interface RenderRecentContextOptions extends SelectRecentContextOptions {
  pageLimit?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function selectRecentContextMessages(
  messages: NativeVisibleMessage[],
  options: SelectRecentContextOptions = {},
): SelectedRecentContextItem[] {
  const messageTarget = options.mode === 'current' ? 3 : 3;
  const maxMessages = options.mode === 'current' ? 3 : 5;
  const selectedMessages: NativeVisibleMessage[] = [];
  const skips: Array<{ afterFromEnd: number; item: SelectedRecentContextItem }> = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'assistant' && message.text.length > LONG_ASSISTANT_SKIP_THRESHOLD) {
      skips.push({ afterFromEnd: selectedMessages.length, item: { kind: 'skip', text: '[上一条 assistant 回复过长，未在最近上下文中展开]' } });
      continue;
    }

    selectedMessages.push(message);
    if (selectedMessages.length >= maxMessages) break;

    if (selectedMessages.length >= messageTarget) {
      const newestThree = selectedMessages.slice(0, messageTarget).reduce((sum, item) => sum + item.text.length, 0);
      if (options.mode === 'current' || newestThree >= RECENT_CONTEXT_EXPAND_THRESHOLD) break;
    }
  }

  const reversedMessages = selectedMessages.reverse().map<SelectedRecentContextItem>(message => ({ kind: 'message', message }));
  for (const skip of skips) {
    const insertionIndex = Math.max(0, reversedMessages.length - skip.afterFromEnd);
    reversedMessages.splice(insertionIndex, 0, skip.item);
  }
  return reversedMessages;
}

function renderItem(item: SelectedRecentContextItem): string {
  if (item.kind === 'skip') return `<i>${escapeHtml(item.text)}</i>`;
  const label = item.message.role === 'user' ? 'U' : 'A';
  return `<b>${label}:</b>\n<pre>${escapeHtml(item.message.text)}</pre>`;
}

function splitPreformatted(label: string, escapedText: string, pageLimit: number): string[] {
  const prefix = `<b>${label}:</b>\n<pre>`;
  const suffix = '</pre>';
  const budget = Math.max(200, pageLimit - prefix.length - suffix.length - 40);
  const chunks: string[] = [];
  for (let i = 0; i < escapedText.length; i += budget) {
    chunks.push(`${prefix}${escapedText.slice(i, i + budget)}${suffix}`);
  }
  return chunks;
}

export function renderRecentContextPages(
  messages: NativeVisibleMessage[],
  options: RenderRecentContextOptions = {},
): string[] {
  const pageLimit = options.pageLimit ?? TELEGRAM_SAFE_PAGE_LIMIT;
  const selected = selectRecentContextMessages(messages, options);
  if (selected.length === 0) return ['<b>最近上下文</b>\n\n<i>没有可显示的最近消息。</i>'];

  const blocks: string[] = [];
  for (const item of selected) {
    if (item.kind === 'message' && item.message.text.length + 80 > pageLimit) {
      const label = item.message.role === 'user' ? 'U' : 'A';
      blocks.push(...splitPreformatted(label, escapeHtml(item.message.text), pageLimit));
    } else {
      blocks.push(renderItem(item));
    }
  }

  const pages: string[] = [];
  let current = '<b>最近上下文</b>\n\n';
  for (const block of blocks) {
    const next = current === '<b>最近上下文</b>\n\n' ? current + block : `${current}\n\n${block}`;
    if (next.length > pageLimit && current !== '<b>最近上下文</b>\n\n') {
      pages.push(current);
      current = '<b>最近上下文</b>\n\n' + block;
    } else {
      current = next;
    }
  }
  pages.push(current);

  if (pages.length === 1) return pages;
  return pages.map((page, idx) => page.replace('<b>最近上下文</b>', `<b>最近上下文</b> (${idx + 1}/${pages.length})`));
}
```

- [ ] **Step 4: Run recent-context tests**

Run:

```bash
npm --prefix bridge test -- recent-context
```

Expected: PASS.

- [ ] **Step 5: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/native/recent-context.ts bridge/src/__tests__/recent-context.test.ts
git commit -m "feat(bridge): render native session context previews"
```

---

## Task 5: Import Native Sessions into TLive Session Records

**Files:**
- Create: `bridge/src/native/claude-session-importer.ts`
- Create: `bridge/src/__tests__/claude-session-importer.test.ts`

- [ ] **Step 1: Write failing importer tests**

Create `bridge/src/__tests__/claude-session-importer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BridgeStore, SessionData } from '../store/interface.js';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import { importClaudeNativeSession } from '../native/claude-session-importer.js';

function candidate(overrides: Partial<ClaudeNativeSessionCandidate> = {}): ClaudeNativeSessionCandidate {
  return {
    sessionId: 'native-12345678',
    sourcePath: 'C:\\Users\\me\\.claude\\projects\\repo\\native-12345678.jsonl',
    cwd: 'D:\\repo',
    cwdSource: 'jsonl',
    cwdExists: true,
    lastActivityAt: '2026-05-06T10:00:00.000Z',
    preview: 'latest user',
    nativePreview: 'latest user',
    recentMessages: [],
    isSidechain: false,
    ...overrides,
  };
}

function mockStore(sessions: SessionData[] = []): BridgeStore {
  const sessionMap = new Map(sessions.map(session => [session.id, session]));
  return {
    getSession: vi.fn(async (id: string) => sessionMap.get(id) ?? null),
    saveSession: vi.fn(async (session: SessionData) => { sessionMap.set(session.id, session); }),
    listSessions: vi.fn(async () => [...sessionMap.values()]),
    deleteSession: vi.fn(),
    getMessages: vi.fn(), saveMessage: vi.fn(),
    getBinding: vi.fn(), saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
    isDuplicate: vi.fn(), markProcessed: vi.fn(),
    acquireLock: vi.fn(), renewLock: vi.fn(), releaseLock: vi.fn(),
    getNativeSessionLease: vi.fn(), saveNativeSessionLease: vi.fn(), deleteNativeSessionLease: vi.fn(), listNativeSessionLeases: vi.fn(),
  } as BridgeStore;
}

describe('claude-session-importer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T11:00:00.000Z'));
  });

  it('creates an imported TLive session from a native candidate', async () => {
    const store = mockStore();

    const imported = await importClaudeNativeSession(store, candidate());

    expect(imported).toMatchObject({
      id: expect.stringMatching(/^session-imported-12345678-\d+$/),
      workingDirectory: 'D:\\repo',
      sdkSessionId: 'native-12345678',
      source: 'claude-native',
      sourcePath: 'C:\\Users\\me\\.claude\\projects\\repo\\native-12345678.jsonl',
      importedAt: '2026-05-06T11:00:00.000Z',
      lastNativeActivityAt: '2026-05-06T10:00:00.000Z',
      nativePreview: 'latest user',
    });
    expect(store.saveSession).toHaveBeenCalledWith(imported);
  });

  it('reuses existing imported session by native session id and preserves importedAt', async () => {
    const existing: SessionData = {
      id: 'session-imported-12345678-1',
      workingDirectory: 'D:\\old',
      createdAt: '2026-05-05T00:00:00.000Z',
      sdkSessionId: 'native-12345678',
      source: 'claude-native',
      importedAt: '2026-05-05T00:00:00.000Z',
      sourcePath: 'old.jsonl',
      nativePreview: 'old',
      lastNativeActivityAt: '2026-05-05T00:00:00.000Z',
    };
    const store = mockStore([existing]);

    const imported = await importClaudeNativeSession(store, candidate({ cwd: 'D:\\new', nativePreview: 'new preview' }));

    expect(imported.id).toBe(existing.id);
    expect(imported.createdAt).toBe(existing.createdAt);
    expect(imported.importedAt).toBe(existing.importedAt);
    expect(imported.workingDirectory).toBe('D:\\new');
    expect(imported.nativePreview).toBe('new preview');
  });

  it('uses explicit cwd override when provided', async () => {
    const store = mockStore();

    const imported = await importClaudeNativeSession(store, candidate(), { cwdOverride: 'D:\\override' });

    expect(imported.workingDirectory).toBe('D:\\override');
  });
});
```

- [ ] **Step 2: Run the failing importer tests**

Run:

```bash
npm --prefix bridge test -- claude-session-importer
```

Expected: FAIL because `../native/claude-session-importer.js` does not exist.

- [ ] **Step 3: Implement importer**

Create `bridge/src/native/claude-session-importer.ts`:

```ts
import type { BridgeStore, SessionData } from '../store/interface.js';
import type { ClaudeNativeSessionCandidate } from './claude-native-scanner.js';

export interface ImportClaudeNativeSessionOptions {
  cwdOverride?: string;
}

function shortNativeId(sessionId: string): string {
  return sessionId.slice(-8);
}

export async function findImportedSessionBySdkSessionId(store: BridgeStore, sdkSessionId: string): Promise<SessionData | null> {
  const sessions = await store.listSessions();
  return sessions.find(session => session.source === 'claude-native' && session.sdkSessionId === sdkSessionId) ?? null;
}

export async function importClaudeNativeSession(
  store: BridgeStore,
  candidate: ClaudeNativeSessionCandidate,
  options: ImportClaudeNativeSessionOptions = {},
): Promise<SessionData> {
  const existing = await findImportedSessionBySdkSessionId(store, candidate.sessionId);
  const now = new Date().toISOString();
  const session: SessionData = {
    ...(existing ?? {
      id: `session-imported-${shortNativeId(candidate.sessionId)}-${Date.now()}`,
      createdAt: now,
      importedAt: now,
    }),
    workingDirectory: options.cwdOverride ?? candidate.cwd ?? existing?.workingDirectory ?? '',
    sdkSessionId: candidate.sessionId,
    source: 'claude-native',
    sourcePath: candidate.sourcePath,
    lastNativeActivityAt: candidate.lastActivityAt,
    nativePreview: candidate.nativePreview,
  };

  await store.saveSession(session);
  return session;
}
```

- [ ] **Step 4: Run importer tests**

Run:

```bash
npm --prefix bridge test -- claude-session-importer
```

Expected: PASS.

- [ ] **Step 5: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/native/claude-session-importer.ts bridge/src/__tests__/claude-session-importer.test.ts
git commit -m "feat(bridge): import native Claude sessions"
```

---

## Task 6: Add Candidate Cache for `/session`

**Files:**
- Create: `bridge/src/engine/native-command-cache.ts`
- Modify: `bridge/src/__tests__/command-router-native-claude.test.ts` or create cache-specific tests in same file when it is introduced in Task 7

- [ ] **Step 1: Write failing cache tests**

Create the first version of `bridge/src/__tests__/command-router-native-claude.test.ts` with cache-only coverage:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import { NativeCommandCandidateCache } from '../engine/native-command-cache.js';

function candidate(id: string): ClaudeNativeSessionCandidate {
  return {
    sessionId: id,
    sourcePath: `${id}.jsonl`,
    cwd: 'D:\\repo',
    cwdSource: 'jsonl',
    cwdExists: true,
    lastActivityAt: '2026-05-06T10:00:00.000Z',
    preview: id,
    nativePreview: id,
    recentMessages: [],
    isSidechain: false,
  };
}

describe('NativeCommandCandidateCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores candidates per chat key for 5 minutes', () => {
    const cache = new NativeCommandCandidateCache();
    cache.set('telegram:c1', [candidate('one')]);

    expect(cache.get('telegram:c1')?.[0].sessionId).toBe('one');

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(cache.get('telegram:c1')).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(cache.get('telegram:c1')).toBeNull();
  });

  it('clears one chat without affecting another', () => {
    const cache = new NativeCommandCandidateCache();
    cache.set('telegram:c1', [candidate('one')]);
    cache.set('telegram:c2', [candidate('two')]);

    cache.clear('telegram:c1');

    expect(cache.get('telegram:c1')).toBeNull();
    expect(cache.get('telegram:c2')?.[0].sessionId).toBe('two');
  });
});
```

- [ ] **Step 2: Run the failing cache tests**

Run:

```bash
npm --prefix bridge test -- command-router-native-claude
```

Expected: FAIL because `../engine/native-command-cache.js` does not exist.

- [ ] **Step 3: Implement cache**

Create `bridge/src/engine/native-command-cache.ts`:

```ts
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';

export const NATIVE_COMMAND_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  createdAt: number;
  candidates: ClaudeNativeSessionCandidate[];
}

export class NativeCommandCandidateCache {
  private entries = new Map<string, CacheEntry>();

  set(chatKey: string, candidates: ClaudeNativeSessionCandidate[], now = Date.now()): void {
    this.entries.set(chatKey, { createdAt: now, candidates });
  }

  get(chatKey: string, now = Date.now()): ClaudeNativeSessionCandidate[] | null {
    const entry = this.entries.get(chatKey);
    if (!entry) return null;
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
```

- [ ] **Step 4: Run cache tests**

Run:

```bash
npm --prefix bridge test -- command-router-native-claude
```

Expected: PASS.

- [ ] **Step 5: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/engine/native-command-cache.ts bridge/src/__tests__/command-router-native-claude.test.ts
git commit -m "feat(bridge): cache native session command candidates"
```

---

## Task 7: Add Telegram Native Claude Commands to CommandRouter

**Files:**
- Modify: `bridge/src/engine/command-router.ts:15-498`
- Modify: `bridge/src/engine/bridge-manager.ts:20-106`
- Modify: `bridge/src/__tests__/command-router-native-claude.test.ts`

- [ ] **Step 1: Replace cache-only command test with full CommandRouter tests**

Extend `bridge/src/__tests__/command-router-native-claude.test.ts` after the cache tests:

```ts
import { CommandRouter } from '../engine/command-router.js';
import { SessionStateManager } from '../engine/session-state.js';
import { ChannelRouter } from '../engine/router.js';
import { initBridgeContext } from '../context.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { BridgeStore, SessionData, NativeSessionLease } from '../store/interface.js';
import { NativeSessionLeaseService } from '../native/native-session-lease.js';

function mockAdapter(channelType = 'telegram'): BaseChannelAdapter {
  return {
    channelType,
    start: vi.fn(), stop: vi.fn(), consumeOne: vi.fn(),
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    editMessage: vi.fn(), sendTyping: vi.fn(), validateConfig: vi.fn(), isAuthorized: vi.fn(),
  } as any;
}

function storeWithNativeState(options: {
  sessions?: SessionData[];
  leases?: NativeSessionLease[];
  bindingSessionId?: string;
} = {}): BridgeStore {
  const sessions = new Map((options.sessions ?? []).map(session => [session.id, session]));
  const leases = new Map((options.leases ?? []).map(lease => [lease.sdkSessionId, lease]));
  let binding = options.bindingSessionId ? { channelType: 'telegram', chatId: 'c1', sessionId: options.bindingSessionId, createdAt: '' } : null;
  return {
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    saveSession: vi.fn(async (session: SessionData) => { sessions.set(session.id, session); }),
    listSessions: vi.fn(async () => [...sessions.values()]),
    deleteSession: vi.fn(),
    getMessages: vi.fn(async () => []), saveMessage: vi.fn(),
    getBinding: vi.fn(async () => binding),
    saveBinding: vi.fn(async (next: any) => { binding = next; }),
    deleteBinding: vi.fn(), listBindings: vi.fn(async () => binding ? [binding] : []),
    isDuplicate: vi.fn(), markProcessed: vi.fn(), acquireLock: vi.fn(), renewLock: vi.fn(), releaseLock: vi.fn(),
    getNativeSessionLease: vi.fn(async (id: string) => leases.get(id) ?? null),
    saveNativeSessionLease: vi.fn(async (lease: NativeSessionLease) => { leases.set(lease.sdkSessionId, lease); }),
    deleteNativeSessionLease: vi.fn(async (id: string) => { leases.delete(id); }),
    listNativeSessionLeases: vi.fn(async () => [...leases.values()]),
  } as BridgeStore;
}

function makeRouter(params: {
  store?: BridgeStore;
  scanner?: () => Promise<ClaudeNativeSessionCandidate[]>;
  findById?: (id: string) => Promise<ClaudeNativeSessionCandidate | null>;
  isChatActive?: () => boolean;
} = {}): { router: CommandRouter; adapter: BaseChannelAdapter; store: BridgeStore; state: SessionStateManager } {
  const store = params.store ?? storeWithNativeState();
  initBridgeContext({
    store,
    defaultWorkdir: 'D:\\default',
    llm: { capabilities: () => ({ slashCommands: true, askUserQuestion: true, liveSession: true, todoTracking: true, costInUsd: true, skills: true, sessionResume: true }), streamChat: vi.fn() } as any,
    permissions: {} as any,
    core: { isHealthy: () => true } as any,
  });
  const state = new SessionStateManager();
  const adapter = mockAdapter('telegram');
  const router = new CommandRouter(
    state,
    () => new Map([['telegram', adapter]]),
    new ChannelRouter(),
    () => true,
    new Map(),
    { clearSessionWhitelist: vi.fn() },
    vi.fn(),
    {
      isChatActive: params.isChatActive ?? (() => false),
      scanNativeSessions: params.scanner ?? (async () => []),
      findNativeSessionById: params.findById ?? (async () => null),
      leaseService: new NativeSessionLeaseService(store),
    },
  );
  return { router, adapter, store, state };
}

async function handle(router: CommandRouter, adapter: BaseChannelAdapter, text: string, channelType = 'telegram') {
  return router.handle(adapter, { channelType: channelType as any, chatId: 'c1', userId: 'u1', text, messageId: `m-${text}` });
}

describe('CommandRouter native Claude commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats /session list and caches indices', async () => {
    const { router, adapter } = makeRouter({ scanner: async () => [candidate('native-12345678')] });

    await handle(router, adapter, '/session');

    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
      html: expect.stringContaining('Claude Code Sessions'),
    }));
    expect((adapter.send as any).mock.calls[0][0].html).toContain('/resume &lt;n&gt;');
    expect((adapter.send as any).mock.calls[0][0].html).toContain('5 minutes');
  });

  it('returns Telegram-only text for non-Telegram native commands', async () => {
    const adapter = mockAdapter('discord');
    const { router } = makeRouter();

    await handle(router, adapter, '/session', 'discord');

    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Telegram only') }));
  });

  it('/resume <n> requires cached candidates', async () => {
    const { router, adapter } = makeRouter();

    await handle(router, adapter, '/resume 1');

    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('/session') }));
  });

  it('numeric resume saves imported session, binding, and lease', async () => {
    const native = candidate('native-12345678');
    const store = storeWithNativeState();
    const { router, adapter } = makeRouter({ store, scanner: async () => [native] });

    await handle(router, adapter, '/session');
    await handle(router, adapter, '/resume 1');

    expect(store.saveSession).toHaveBeenCalledWith(expect.objectContaining({ sdkSessionId: 'native-12345678', source: 'claude-native' }));
    expect(store.saveBinding).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.stringContaining('session-imported-12345678') }));
    expect(store.saveNativeSessionLease).toHaveBeenCalledWith(expect.objectContaining({ sdkSessionId: 'native-12345678', owner: 'telegram:c1' }));
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('12345678') }));
  });

  it('rejects missing cwd unless cwd provides an absolute existing directory', async () => {
    const native = candidate('native-12345678');
    native.cwd = undefined;
    native.cwdExists = false;
    const { router, adapter, store } = makeRouter({ scanner: async () => [native] });

    await handle(router, adapter, '/session');
    await handle(router, adapter, '/resume 1');
    expect(adapter.send).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('cwd') }));

    await handle(router, adapter, '/session');
    await handle(router, adapter, '/resume 1 cwd "D:\\My Projects\\repo"');
    expect(store.saveSession).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: 'D:\\My Projects\\repo' }));
  });

  it('/resume current uses current imported binding without candidate cache', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native', sourcePath: 'native.jsonl', importedAt: '', lastNativeActivityAt: '', nativePreview: 'preview' };
    const store = storeWithNativeState({ sessions: [session], bindingSessionId: 'imported' });
    const { router, adapter } = makeRouter({ store, findById: async () => candidate('native-12345678') });

    await handle(router, adapter, '/resume current');

    expect(store.saveNativeSessionLease).toHaveBeenCalledWith(expect.objectContaining({ sdkSessionId: 'native-12345678' }));
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('12345678') }));
  });

  it('/release releases lease, clears cache, keeps binding, and shows desktop resume guidance', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native', importedAt: '', sourcePath: 'native.jsonl' };
    const lease: NativeSessionLease = { sdkSessionId: 'native-12345678', owner: 'telegram:c1', ownerUserId: 'u1', tliveSessionId: 'imported', lockedAt: '2026-05-06T09:55:00.000Z', lastActiveAt: '2026-05-06T09:55:00.000Z', ttlMinutes: 30 };
    const store = storeWithNativeState({ sessions: [session], leases: [lease], bindingSessionId: 'imported' });
    const { router, adapter } = makeRouter({ store });

    await handle(router, adapter, '/release');

    expect(store.deleteNativeSessionLease).toHaveBeenCalledWith('native-12345678');
    expect(store.saveBinding).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('claude --resume native-12345678') }));
  });

  it('/release, /new, /session, and /runtime codex reject while work is running', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native' };
    const store = storeWithNativeState({ sessions: [session], bindingSessionId: 'imported' });
    const { router, adapter } = makeRouter({ store, isChatActive: () => true });

    await handle(router, adapter, '/release');
    await handle(router, adapter, '/new');
    await handle(router, adapter, '/session 1');
    await handle(router, adapter, '/runtime codex');

    const sent = (adapter.send as any).mock.calls.map((call: any[]) => call[0].text ?? call[0].html).join('\n');
    expect(sent).toContain('/stop');
    expect(store.deleteNativeSessionLease).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the failing command-router tests**

Run:

```bash
npm --prefix bridge test -- command-router-native-claude
```

Expected: FAIL because `CommandRouter` does not accept the native command dependency object and does not handle native commands.

- [ ] **Step 3: Add native command dependencies to CommandRouter**

In `bridge/src/engine/command-router.ts`, add imports:

```ts
import { isAbsolute, basename, dirname } from 'node:path';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import { scanClaudeNativeSessions, findClaudeNativeSessionById } from '../native/claude-native-scanner.js';
import { renderRecentContextPages } from '../native/recent-context.js';
import { importClaudeNativeSession } from '../native/claude-session-importer.js';
import { NativeSessionLeaseService, maskLeaseOwner, nativeLeaseOwner } from '../native/native-session-lease.js';
import { NativeCommandCandidateCache } from './native-command-cache.js';
import type { SessionData } from '../store/interface.js';
```

Add dependency interface before the class:

```ts
interface NativeCommandDependencies {
  isChatActive?: (channelType: string, chatId: string) => boolean;
  scanNativeSessions?: () => Promise<ClaudeNativeSessionCandidate[]>;
  findNativeSessionById?: (sessionId: string) => Promise<ClaudeNativeSessionCandidate | null>;
  leaseService?: NativeSessionLeaseService;
  candidateCache?: NativeCommandCandidateCache;
}
```

Change constructor signature:

```ts
  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private coreAvailable: () => boolean,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
    private onNewSession?: (channelType: string, chatId: string) => void,
    private nativeDeps: NativeCommandDependencies = {},
  ) {}
```

Add class fields:

```ts
  private nativeCandidateCache = this.nativeDeps.candidateCache ?? new NativeCommandCandidateCache();
```

If TypeScript complains about field initializer using constructor parameter property before initialization, move initialization into the constructor body by converting parameter properties to explicit assignments.

- [ ] **Step 4: Add command parsing and formatting helpers**

Add helper methods inside `CommandRouter`:

```ts
  private chatKey(channelType: string, chatId: string): string {
    return this.state.stateKey(channelType, chatId);
  }

  private nativeLeaseService(): NativeSessionLeaseService {
    return this.nativeDeps.leaseService ?? new NativeSessionLeaseService(getBridgeContext().store);
  }

  private isChatRunning(channelType: string, chatId: string): boolean {
    const key = this.chatKey(channelType, chatId);
    return this.state.isProcessing(key) || !!this.nativeDeps.isChatActive?.(channelType, chatId);
  }

  private async rejectIfNativeRunning(adapter: BaseChannelAdapter, chatId: string, channelType: string): Promise<boolean> {
    if (!this.isChatRunning(channelType, chatId)) return false;
    await adapter.send({ chatId, text: '⚠️ 当前任务仍在运行。请先发送 /stop，或等待任务完成后再切换/释放。' });
    return true;
  }

  private ensureTelegramNativeCommand(adapter: BaseChannelAdapter, chatId: string): boolean {
    if (adapter.channelType === 'telegram') return true;
    adapter.send({ chatId, text: 'Native Claude Code session commands are currently Telegram only.' }).catch(() => {});
    return false;
  }

  private parseResumeArgs(raw: string): { target?: string; cwdOverride?: string; error?: string } {
    const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
    const target = tokens[1];
    let cwdOverride: string | undefined;
    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i] !== 'cwd') return { target, error: 'Usage: /resume <n|current> [cwd "D:\\path with spaces"]' };
      const rawPath = tokens[i + 1];
      if (!rawPath) return { target, error: 'Missing path after cwd.' };
      cwdOverride = rawPath.startsWith('"') && rawPath.endsWith('"') ? rawPath.slice(1, -1) : rawPath;
      i += 1;
    }
    return { target, cwdOverride };
  }

  private validateCwdOverride(cwdOverride: string | undefined): string | undefined {
    if (!cwdOverride) return undefined;
    if (!isAbsolute(cwdOverride)) return 'cwd must be an absolute path.';
    try {
      if (!existsSync(cwdOverride)) return 'cwd path does not exist.';
      const stat = require('node:fs').statSync(cwdOverride) as import('node:fs').Stats;
      if (!stat.isDirectory()) return 'cwd must be a directory, not a file.';
      return undefined;
    } catch {
      return 'cwd path cannot be read.';
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }
```

Use `statSync` in the top import instead of `require()` if preferred:

```ts
import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
```

Then `validateCwdOverride()` should call `statSync(cwdOverride).isDirectory()`.

- [ ] **Step 5: Add `/session` list command**

Add a switch branch before `/sessions`:

```ts
      case '/session': {
        if (!this.ensureTelegramNativeCommand(adapter, msg.chatId)) return true;
        const scan = this.nativeDeps.scanNativeSessions ?? (() => scanClaudeNativeSessions());
        const candidates = await scan();
        if (candidates.length === 0) {
          await adapter.send({ chatId: msg.chatId, text: 'No Claude Code history sessions found. Use Claude Code on this machine first, then run /session again.' });
          return true;
        }

        const { store } = getBridgeContext();
        const leases = await store.listNativeSessionLeases();
        const leaseById = new Map(leases.map(lease => [lease.sdkSessionId, lease]));
        const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
        const lines = ['<b>📋 Claude Code Sessions</b>', ''];
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const markers: string[] = [];
          const lease = leaseById.get(candidate.sessionId);
          if (lease) markers.push(lease.owner === owner ? 'locked by you' : `locked ${maskLeaseOwner(lease.owner)}`);
          if (!candidate.cwd) markers.push('cwd unknown');
          else if (!candidate.cwdExists) markers.push('path missing');
          const imported = (await store.listSessions()).some(s => s.source === 'claude-native' && s.sdkSessionId === candidate.sessionId);
          if (imported) markers.push('imported');
          if (candidate.gitBranch) markers.push(candidate.gitBranch);
          const name = candidate.cwd ? basename(candidate.cwd) : candidate.sessionId.slice(-8);
          const date = new Date(candidate.lastActivityAt).toLocaleString('zh-CN', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          lines.push(`${i + 1}. <b>${this.escapeHtml(name)}</b> · ${this.escapeHtml(date)}${markers.length ? ' · ' + this.escapeHtml(markers.join(' · ')) : ''}`);
          lines.push(`   <code>${this.escapeHtml(this.truncate(candidate.cwd ?? candidate.sourcePath, 100))}</code>`);
          lines.push(`   ${this.escapeHtml(this.truncate(candidate.preview, 100))}`);
        }
        lines.push('', 'Use <code>/resume &lt;n&gt;</code> within 5 minutes to take over.');
        this.nativeCandidateCache.set(this.chatKey(msg.channelType, msg.chatId), candidates);
        await adapter.send({ chatId: msg.chatId, html: lines.join('\n') });
        return true;
      }
```

Optimize later by computing `const sessions = await store.listSessions()` once before the loop.

- [ ] **Step 6: Add `/resume` command**

Add a switch branch:

```ts
      case '/resume': {
        if (!this.ensureTelegramNativeCommand(adapter, msg.chatId)) return true;
        const parsed = this.parseResumeArgs(msg.text);
        if (parsed.error || !parsed.target) {
          await adapter.send({ chatId: msg.chatId, text: parsed.error ?? 'Usage: /resume <n|current> [cwd "D:\\path"]' });
          return true;
        }
        const cwdError = this.validateCwdOverride(parsed.cwdOverride);
        if (cwdError) {
          await adapter.send({ chatId: msg.chatId, text: `Invalid cwd: ${cwdError}` });
          return true;
        }

        const { store, llm } = getBridgeContext();
        let candidate: ClaudeNativeSessionCandidate | null = null;
        let existingImported: SessionData | null = null;
        if (parsed.target === 'current') {
          const binding = await this.router.resolve(msg.channelType, msg.chatId);
          existingImported = await store.getSession(binding.sessionId);
          if (!existingImported || existingImported.source !== 'claude-native' || !existingImported.sdkSessionId) {
            await adapter.send({ chatId: msg.chatId, text: 'Current TLive session is not an imported native Claude session. Use /session first.' });
            return true;
          }
          const find = this.nativeDeps.findNativeSessionById ?? ((id: string) => findClaudeNativeSessionById(id));
          candidate = await find(existingImported.sdkSessionId);
          if (!candidate) {
            candidate = {
              sessionId: existingImported.sdkSessionId,
              sourcePath: existingImported.sourcePath ?? '',
              cwd: existingImported.workingDirectory,
              cwdSource: 'jsonl',
              cwdExists: true,
              lastActivityAt: existingImported.lastNativeActivityAt ?? existingImported.createdAt,
              preview: existingImported.nativePreview ?? '(empty)',
              nativePreview: existingImported.nativePreview ?? '(empty)',
              recentMessages: [],
              isSidechain: false,
            };
          }
        } else {
          const index = Number.parseInt(parsed.target, 10);
          const cached = this.nativeCandidateCache.get(this.chatKey(msg.channelType, msg.chatId));
          if (!cached || Number.isNaN(index) || index < 1 || index > cached.length) {
            await adapter.send({ chatId: msg.chatId, text: 'Run /session first, then use /resume <n> within 5 minutes.' });
            return true;
          }
          candidate = cached[index - 1];
        }

        const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
        const existingLease = await store.getNativeSessionLease(candidate.sessionId);
        if (existingLease && existingLease.owner !== owner) {
          const activeLease = await this.nativeLeaseService().getActive(candidate.sessionId);
          if (activeLease && activeLease.owner !== owner) {
            await adapter.send({ chatId: msg.chatId, text: `This native Claude session is locked by ${maskLeaseOwner(activeLease.owner)}.` });
            return true;
          }
        }

        const finalCwd = parsed.cwdOverride ?? candidate.cwd;
        if (!finalCwd || (!candidate.cwdExists && !parsed.cwdOverride)) {
          await adapter.send({ chatId: msg.chatId, text: 'This session has missing or unknown cwd. Retry with: /resume <n> cwd "D:\\absolute\\project"' });
          return true;
        }

        const imported = await importClaudeNativeSession(store, candidate, { cwdOverride: finalCwd });
        const leaseResult = await this.nativeLeaseService().acquire({
          sdkSessionId: candidate.sessionId,
          owner,
          ownerUserId: msg.userId,
          tliveSessionId: imported.id,
        });
        if (leaseResult.status === 'blocked') {
          await adapter.send({ chatId: msg.chatId, text: `This native Claude session is locked by ${maskLeaseOwner(leaseResult.lease!.owner)}.` });
          return true;
        }

        const previousRuntime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
        if (previousRuntime !== 'claude') this.state.setRuntime(msg.channelType, msg.chatId, 'claude');
        await this.router.rebind(msg.channelType, msg.chatId, imported.id);
        this.nativeCandidateCache.clear(this.chatKey(msg.channelType, msg.chatId));

        const status = [
          `<b>✅ Claude native session resumed</b>`,
          `Session: <code>${this.escapeHtml(candidate.sessionId.slice(-8))}</code>`,
          `cwd: <code>${this.escapeHtml(finalCwd)}</code>`,
          candidate.gitBranch ? `branch: <code>${this.escapeHtml(candidate.gitBranch)}</code>` : undefined,
          previousRuntime !== 'claude' ? 'Runtime switched to Claude.' : undefined,
          'Lease TTL: 30 idle minutes.',
          'Do not type into desktop Claude Code concurrently.',
          'Use /release when done.',
        ].filter(Boolean).join('\n');
        await adapter.send({ chatId: msg.chatId, html: status });

        const pages = renderRecentContextPages(candidate.recentMessages, { mode: parsed.target === 'current' ? 'current' : 'resume' });
        for (const page of pages) await adapter.send({ chatId: msg.chatId, html: page });
        return true;
      }
```

Then add settings/permission warnings after the status fields:

```ts
const currentSettingSources = llm instanceof ClaudeSDKProvider ? llm.getSettingSources() : [];
const settingsLabel = currentSettingSources.length === 0 ? 'isolated' : currentSettingSources.includes('project') ? 'full' : 'user';
const permMode = this.state.getPermMode(msg.channelType, msg.chatId);
```

Include warning lines when `settingsLabel === 'isolated'` and `permMode === 'off'`.

- [ ] **Step 7: Add `/release` command**

Add a switch branch before `/sessions`:

```ts
      case '/release': {
        if (!this.ensureTelegramNativeCommand(adapter, msg.chatId)) return true;
        if (await this.rejectIfNativeRunning(adapter, msg.chatId, msg.channelType)) return true;

        const { store } = getBridgeContext();
        const binding = await this.router.resolve(msg.channelType, msg.chatId);
        const session = await store.getSession(binding.sessionId);
        if (!session || session.source !== 'claude-native' || !session.sdkSessionId) {
          await adapter.send({ chatId: msg.chatId, text: 'Current session is not a Telegram takeover of a native Claude session.' });
          return true;
        }

        const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
        const releaseResult = await this.nativeLeaseService().release(session.sdkSessionId, owner);
        if (releaseResult.status === 'blocked') {
          await adapter.send({ chatId: msg.chatId, text: `Cannot release: session is owned by ${maskLeaseOwner(releaseResult.lease!.owner)}.` });
          return true;
        }

        this.onNewSession?.(msg.channelType, msg.chatId);
        this.nativeCandidateCache.clear(this.chatKey(msg.channelType, msg.chatId));
        const expiredLine = releaseResult.status === 'expired' ? 'Lease had already auto-expired; local state was cleaned up.\n' : '';
        const cwdLine = session.workingDirectory ? `Run from <code>${this.escapeHtml(session.workingDirectory)}</code>:` : 'Run from the correct project directory:';
        await adapter.send({
          chatId: msg.chatId,
          html: `${expiredLine}<b>Released native Claude session</b>\n${cwdLine}\n<code>claude --resume ${this.escapeHtml(session.sdkSessionId)}</code>`,
        });
        return true;
      }
```

- [ ] **Step 8: Update `/new`, `/session`, `/runtime`, `/stop`, `/sessions`, and `/help`**

For `/new`, before `this.onNewSession?.(...)`:

```ts
        if (await this.rejectIfNativeRunning(adapter, msg.chatId, msg.channelType)) return true;
        await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
        this.nativeCandidateCache.clear(this.chatKey(msg.channelType, msg.chatId));
```

Add helper:

```ts
  private async releaseCurrentNativeLeaseIfOwned(channelType: string, chatId: string): Promise<void> {
    const { store } = getBridgeContext();
    const binding = await store.getBinding(channelType, chatId);
    if (!binding) return;
    const session = await store.getSession(binding.sessionId);
    if (!session?.sdkSessionId || session.source !== 'claude-native') return;
    await this.nativeLeaseService().release(session.sdkSessionId, nativeLeaseOwner(channelType, chatId));
  }
```

For `/session`, before rebind:

```ts
        if (await this.rejectIfNativeRunning(adapter, msg.chatId, msg.channelType)) return true;
        await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
        this.nativeCandidateCache.clear(this.chatKey(msg.channelType, msg.chatId));
```

For `/runtime`, when switching to `codex` or changing provider:

```ts
          if (runtime === 'codex' && await this.rejectIfNativeRunning(adapter, msg.chatId, msg.channelType)) return true;
          if (runtime === 'codex') await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
          if (prevRuntime !== runtime) this.nativeCandidateCache.clear(this.chatKey(msg.channelType, msg.chatId));
```

For `/stop`, after interrupt/no-active branch handling:

```ts
          await this.refreshCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
```

Add helper:

```ts
  private async refreshCurrentNativeLeaseIfOwned(channelType: string, chatId: string): Promise<void> {
    const { store } = getBridgeContext();
    const binding = await store.getBinding(channelType, chatId);
    if (!binding) return;
    const session = await store.getSession(binding.sessionId);
    if (!session?.sdkSessionId || session.source !== 'claude-native') return;
    await this.nativeLeaseService().refresh(session.sdkSessionId, nativeLeaseOwner(channelType, chatId));
  }
```

For `/sessions`, change preview and marker:

```ts
          const nativeMarker = s.source === 'claude-native' ? '[Claude native] ' : '';
          const preview = firstUser
            ? (firstUser.content.length > 40 ? firstUser.content.slice(0, 37) + '...' : firstUser.content)
            : (s.nativePreview ? (s.nativePreview.length > 40 ? s.nativePreview.slice(0, 37) + '...' : s.nativePreview) : '(empty)');
          lines.push(`${i + 1}. ${date} — ${nativeMarker}${preview}${marker}`);
```

For Telegram `/help`, add lines:

```ts
            '<code>/session</code> — List native Claude Code sessions',
            '<code>/resume &lt;n|current&gt;</code> — Take over native Claude session',
            '<code>/release</code> — Release Telegram takeover',
```

- [ ] **Step 9: Wire BridgeManager**

In `bridge/src/engine/bridge-manager.ts`, update `QUICK_COMMANDS`:

```ts
const QUICK_COMMANDS = new Set(['/menu', '/new', '/status', '/verbose', '/hooks', '/sessions', '/session', '/help', '/perm', '/effort', '/stop', '/approve', '/pairings', '/runtime', '/settings', '/model', '/resume', '/release']);
```

Update `new CommandRouter(...)` call:

```ts
      (channelType, chatId) => this.sdkEngine.closeSession(channelType, chatId),
      { isChatActive: (channelType, chatId) => this.sdkEngine.isChatActive(channelType, chatId) },
```

- [ ] **Step 10: Run command router tests**

Run:

```bash
npm --prefix bridge test -- command-router-native-claude
```

Expected: PASS.

- [ ] **Step 11: Run bridge-manager regression tests**

Run:

```bash
npm --prefix bridge test -- bridge-manager
```

Expected: PASS.

- [ ] **Step 12: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/engine/command-router.ts bridge/src/engine/bridge-manager.ts bridge/src/__tests__/command-router-native-claude.test.ts
git commit -m "feat(bridge): add Telegram native Claude session commands"
```

---

## Task 8: Guard Ordinary Messages to Released or Non-Owned Imported Sessions

**Files:**
- Modify: `bridge/src/engine/sdk-engine.ts:18-629`
- Create: `bridge/src/__tests__/sdk-engine-native-guard.test.ts`

- [ ] **Step 1: Write failing SDK guard tests**

Create `bridge/src/__tests__/sdk-engine-native-guard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKEngine } from '../engine/sdk-engine.js';
import { SessionStateManager } from '../engine/session-state.js';
import { ChannelRouter } from '../engine/router.js';
import { initBridgeContext } from '../context.js';
import type { BaseChannelAdapter } from '../channels/base.js';
import type { BridgeStore, SessionData, NativeSessionLease } from '../store/interface.js';

function adapter(): BaseChannelAdapter {
  return {
    channelType: 'telegram', start: vi.fn(), stop: vi.fn(), consumeOne: vi.fn(),
    send: vi.fn().mockResolvedValue({ messageId: '1', success: true }),
    editMessage: vi.fn(), sendTyping: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn(),
    validateConfig: vi.fn(), isAuthorized: vi.fn(),
  } as any;
}

function storeWith(session: SessionData, lease?: NativeSessionLease): BridgeStore {
  const leases = new Map<string, NativeSessionLease>();
  if (lease) leases.set(lease.sdkSessionId, lease);
  return {
    getSession: vi.fn(async () => session),
    saveSession: vi.fn(async (next: SessionData) => { session = next; }),
    listSessions: vi.fn(), deleteSession: vi.fn(),
    getMessages: vi.fn(),
    saveMessage: vi.fn(),
    getBinding: vi.fn(async () => ({ channelType: 'telegram', chatId: 'c1', sessionId: session.id, createdAt: '' })),
    saveBinding: vi.fn(), deleteBinding: vi.fn(), listBindings: vi.fn(),
    isDuplicate: vi.fn(), markProcessed: vi.fn(), acquireLock: vi.fn(async () => true), renewLock: vi.fn(), releaseLock: vi.fn(),
    getNativeSessionLease: vi.fn(async (id: string) => leases.get(id) ?? null),
    saveNativeSessionLease: vi.fn(async (next: NativeSessionLease) => { leases.set(next.sdkSessionId, next); }),
    deleteNativeSessionLease: vi.fn(async (id: string) => { leases.delete(id); }),
    listNativeSessionLeases: vi.fn(async () => [...leases.values()]),
  } as BridgeStore;
}

function provider() {
  return {
    capabilities: () => ({ slashCommands: true, askUserQuestion: true, liveSession: false, todoTracking: true, costInUsd: true, skills: true, sessionResume: true }),
    streamChat: vi.fn(() => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ kind: 'text_delta', text: 'ok' });
          controller.enqueue({ kind: 'query_result', sessionId: 'native-12345678', isError: false, usage: { inputTokens: 1, outputTokens: 1 } });
          controller.close();
        },
      }),
    })),
  } as any;
}

describe('SDKEngine native session guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks ordinary messages to released imported native sessions before saving', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native' };
    const store = storeWith(session);
    initBridgeContext({ store, defaultWorkdir: 'D:\\default', llm: provider(), permissions: {} as any, core: {} as any });
    const engine = new SDKEngine(new SessionStateManager(), new ChannelRouter(), {} as any);
    const a = adapter();

    await engine.handleMessage(a, { channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1' }, provider());

    expect(store.saveMessage).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('/resume current') }));
  });

  it('blocks ordinary messages when another chat owns the lease', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native' };
    const lease: NativeSessionLease = { sdkSessionId: 'native-12345678', owner: 'telegram:other-chat-9999', tliveSessionId: 'imported', lockedAt: '2026-05-06T09:59:00.000Z', lastActiveAt: '2026-05-06T09:59:00.000Z', ttlMinutes: 30 };
    const store = storeWith(session, lease);
    initBridgeContext({ store, defaultWorkdir: 'D:\\default', llm: provider(), permissions: {} as any, core: {} as any });
    const engine = new SDKEngine(new SessionStateManager(), new ChannelRouter(), {} as any);
    const a = adapter();

    await engine.handleMessage(a, { channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1' }, provider());

    expect(store.saveMessage).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('telegram:*9999') }));
  });

  it('refreshes valid owner lease and proceeds', async () => {
    const session: SessionData = { id: 'imported', workingDirectory: 'D:\\repo', createdAt: '', sdkSessionId: 'native-12345678', source: 'claude-native' };
    const lease: NativeSessionLease = { sdkSessionId: 'native-12345678', owner: 'telegram:c1', tliveSessionId: 'imported', lockedAt: '2026-05-06T09:59:00.000Z', lastActiveAt: '2026-05-06T09:59:00.000Z', ttlMinutes: 30 };
    const store = storeWith(session, lease);
    initBridgeContext({ store, defaultWorkdir: 'D:\\default', llm: provider(), permissions: {} as any, core: {} as any });
    const engine = new SDKEngine(new SessionStateManager(), new ChannelRouter(), {} as any);

    await engine.handleMessage(adapter(), { channelType: 'telegram', chatId: 'c1', userId: 'u1', text: 'hello', messageId: 'm1' }, provider());

    expect(store.saveMessage).toHaveBeenCalledWith('imported', expect.objectContaining({ role: 'user', content: 'hello' }));
    expect(store.saveNativeSessionLease).toHaveBeenCalledWith(expect.objectContaining({ lastActiveAt: '2026-05-06T10:00:00.000Z' }));
  });

  it('reports chat active when processing flag or live turn is active', () => {
    const state = new SessionStateManager();
    const engine = new SDKEngine(state, new ChannelRouter(), {} as any);
    state.setProcessing('telegram:c1', true);

    expect(engine.isChatActive('telegram', 'c1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing SDK guard tests**

Run:

```bash
npm --prefix bridge test -- sdk-engine-native-guard
```

Expected: FAIL because `SDKEngine.isChatActive` and native guard logic do not exist.

- [ ] **Step 3: Add `isChatActive()` to SDKEngine**

In `bridge/src/engine/sdk-engine.ts`, add method near `getActiveControls()`:

```ts
  isChatActive(channelType: string, chatId: string): boolean {
    const chatKey = this.state.stateKey(channelType, chatId);
    if (this.state.isProcessing(chatKey)) return true;
    for (const [key, managed] of this.registry) {
      if (key.startsWith(`${channelType}:${chatId}:`) && managed.session.isTurnActive) return true;
    }
    return false;
  }
```

- [ ] **Step 4: Add native message guard helper**

Add imports:

```ts
import { NativeSessionLeaseService, maskLeaseOwner, nativeLeaseOwner } from '../native/native-session-lease.js';
```

Add helper before `handleMessage()`:

```ts
  private async guardNativeImportedMessage(adapter: BaseChannelAdapter, msg: InboundMessage, session: Awaited<ReturnType<typeof getBridgeContext>>['store'] extends never ? never : any): Promise<'allow' | 'blocked'> {
    if (!session || session.source !== 'claude-native' || !session.sdkSessionId) return 'allow';
    const { store } = getBridgeContext();
    const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
    const leases = new NativeSessionLeaseService(store);
    const refresh = await leases.refresh(session.sdkSessionId, owner);
    if (refresh.status === 'refreshed') return 'allow';
    if (refresh.status === 'blocked' && refresh.lease) {
      await adapter.send({ chatId: msg.chatId, text: `该 Claude session 当前由 ${maskLeaseOwner(refresh.lease.owner)} 接管。请等待对方 /release，或选择其他 session。` });
      return 'blocked';
    }
    await adapter.send({ chatId: msg.chatId, text: '该 Claude session 当前已释放，未由 Telegram 接管。\n发送 /resume current 重新接管，或 /new 开始新的 TLive 会话。' });
    return 'blocked';
  }
```

Use a proper `SessionData | null` type instead of the awkward inferred type:

```ts
import type { SessionData } from '../store/interface.js';
```

Then signature:

```ts
  private async guardNativeImportedMessage(adapter: BaseChannelAdapter, msg: InboundMessage, session: SessionData | null): Promise<'allow' | 'blocked'>
```

- [ ] **Step 5: Call guard before typing and reactions**

In `handleMessage()`, after session lookup and before thread resolution/typing:

```ts
    const nativeGuard = await this.guardNativeImportedMessage(adapter, msg, session);
    if (nativeGuard === 'blocked') return true;
```

This location must be before `setInterval()` and before `store.saveMessage()` is reachable.

- [ ] **Step 6: Refresh lease on task completion and release on resume failure**

In the `try` block after `await this.engine.processMessage(...)` succeeds, add:

```ts
      if (session?.source === 'claude-native' && session.sdkSessionId) {
        await new NativeSessionLeaseService(getBridgeContext().store).refresh(session.sdkSessionId, nativeLeaseOwner(msg.channelType, msg.chatId));
      }
```

In `catch (err)`, before `throw err`, add:

```ts
      if (session?.source === 'claude-native' && session.sdkSessionId) {
        await new NativeSessionLeaseService(getBridgeContext().store).release(session.sdkSessionId, nativeLeaseOwner(msg.channelType, msg.chatId));
      }
```

If this releases on any LLM error and proves too broad in tests, narrow it later to LiveSession start/resume failures by wrapping `getOrCreateSession()` and `managed.session.startTurn()` in a local try/catch. First implementation should satisfy the spec requirement: do not keep a stale takeover after resume/start failure.

- [ ] **Step 7: Run SDK guard tests**

Run:

```bash
npm --prefix bridge test -- sdk-engine-native-guard
```

Expected: PASS.

- [ ] **Step 8: Run conversation and bridge-manager regression tests**

Run:

```bash
npm --prefix bridge test -- conversation bridge-manager
```

Expected: PASS.

- [ ] **Step 9: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/engine/sdk-engine.ts bridge/src/__tests__/sdk-engine-native-guard.test.ts
git commit -m "feat(bridge): guard native Claude session takeovers"
```

---

## Task 9: Preserve Imported Session Metadata on `sdkSessionId` Updates

**Files:**
- Modify: `bridge/src/engine/conversation.ts:132-142`
- Modify: `bridge/src/__tests__/conversation.test.ts`

- [ ] **Step 1: Write failing metadata preservation test**

Append to `bridge/src/__tests__/conversation.test.ts`:

```ts
it('preserves imported native session metadata when updating sdkSessionId', async () => {
  let session = {
    id: 'imported',
    workingDirectory: 'D:\\repo',
    createdAt: '2026-05-06T09:00:00.000Z',
    sdkSessionId: 'old-native',
    source: 'claude-native' as const,
    sourcePath: 'native.jsonl',
    importedAt: '2026-05-06T09:00:00.000Z',
    lastNativeActivityAt: '2026-05-06T09:30:00.000Z',
    nativePreview: 'preview',
  };
  const store = {
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(session),
    saveSession: vi.fn(async (next) => { session = next; }),
  } as any;

  initBridgeContext({
    store,
    defaultWorkdir: 'D:\\default',
    llm: {
      streamChat: () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ kind: 'query_result', sessionId: 'new-native', isError: false, usage: { inputTokens: 1, outputTokens: 1 } });
            controller.close();
          },
        }),
      }),
    } as any,
    permissions: {} as any,
    core: {} as any,
  });

  const engine = new ConversationEngine();
  await engine.processMessage({ sessionId: 'imported', text: 'hello' });

  expect(store.saveSession).toHaveBeenCalledWith(expect.objectContaining({
    id: 'imported',
    sdkSessionId: 'new-native',
    source: 'claude-native',
    sourcePath: 'native.jsonl',
    importedAt: '2026-05-06T09:00:00.000Z',
    lastNativeActivityAt: '2026-05-06T09:30:00.000Z',
    nativePreview: 'preview',
  }));
});
```

If the existing test file uses a different setup style, adapt only imports and context initialization while keeping the assertion exact.

- [ ] **Step 2: Run the failing conversation test**

Run:

```bash
npm --prefix bridge test -- conversation
```

Expected: FAIL because `saveSession()` currently writes only `id`, `workingDirectory`, `createdAt`, and `sdkSessionId`.

- [ ] **Step 3: Preserve session fields in ConversationEngine**

Change `bridge/src/engine/conversation.ts:135-141` from:

```ts
await store.saveSession({
  id: params.sessionId,
  workingDirectory: existing?.workingDirectory ?? defaultWorkdir,
  createdAt: existing?.createdAt ?? new Date().toISOString(),
  sdkSessionId: value.sessionId,
});
```

to:

```ts
await store.saveSession({
  ...(existing ?? { id: params.sessionId, workingDirectory: defaultWorkdir, createdAt: new Date().toISOString() }),
  id: params.sessionId,
  workingDirectory: existing?.workingDirectory ?? defaultWorkdir,
  createdAt: existing?.createdAt ?? new Date().toISOString(),
  sdkSessionId: value.sessionId,
});
```

- [ ] **Step 4: Run conversation tests**

Run:

```bash
npm --prefix bridge test -- conversation
```

Expected: PASS.

- [ ] **Step 5: Commit**

If committing is authorized for this implementation run:

```bash
git add bridge/src/engine/conversation.ts bridge/src/__tests__/conversation.test.ts
git commit -m "fix(bridge): preserve native session metadata"
```

---

## Task 10: Documentation and Full Validation

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Possibly generated by build if tracked: none currently found for `bridge/dist/main.mjs`

- [ ] **Step 1: Add concise command docs**

In `README.md`, add a short Telegram command subsection near the existing TLive bridge command docs:

```md
### Telegram: native Claude Code sessions

- `/session` — list recent native Claude Code sessions from this machine.
- `/session all` — list all scanned native Claude Code sessions from this machine.
- `/resume <n|current>` — take over a listed or current imported Claude Code session from Telegram.
- `/resume <n|current> cwd "<absolute path>"` — override the working directory when resuming.
- `/release` — release the Telegram takeover and show the desktop `claude --resume <session-id>` command.
```

In `README_CN.md`, add:

```md
### Telegram：接续原生 Claude Code 会话

- `/session` — 列出本机最近的原生 Claude Code 会话。
- `/session all` — 列出本机全部扫描到的原生 Claude Code 会话。
- `/resume <n|current>` — 在 Telegram 接管列表中的会话，或重新接管当前已导入会话。
- `/resume <n|current> cwd "<绝对路径>"` — 接管时覆盖工作目录。
- `/release` — 释放 Telegram 接管，并显示桌面端 `claude --resume <session-id>` 命令。
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm --prefix bridge test -- claude-native-scanner recent-context native-session-lease claude-session-importer command-router-native-claude sdk-engine-native-guard json-file-store conversation bridge-manager
```

Expected: PASS.

- [ ] **Step 3: Run full bridge tests**

Run:

```bash
npm --prefix bridge test
```

Expected: PASS.

- [ ] **Step 4: Run bridge build**

Run:

```bash
npm --prefix bridge run build
```

Expected: PASS with esbuild output and no TypeScript errors.

- [ ] **Step 5: Check whether build output is tracked**

Run:

```bash
git ls-files bridge/dist/main.mjs
```

Expected in current repo state: no output. If no output, do not add `bridge/dist/main.mjs`. If output appears after future repo changes, include generated build output without hand-editing it.

- [ ] **Step 6: Manual Telegram verification**

Run the bridge normally, then in Telegram verify:

```text
/session
/resume <n>
<send one ordinary resumed message>
/release
<send ordinary message and confirm it is blocked>
/resume current
```

Expected:

- `/session` lists five native Claude Code sessions by default with index validity notice; `/session all` lists all scanned candidates.
- `/resume <n>` sends takeover status, recent context pages, and no empty prompt to Claude.
- The ordinary resumed message uses the existing native `sdkSessionId` path.
- `/release` shows `claude --resume <session-id>` and keeps the binding.
- Ordinary message after release is blocked before TLive message history save.
- `/resume current` reacquires the lease and shows short recent context.

Do not automatically run desktop `claude --resume`; leave it as a manual back-to-desktop check.

- [ ] **Step 7: Commit**

If committing is authorized for this implementation run:

```bash
git add README.md README_CN.md
git commit -m "docs: document Telegram native Claude session commands"
```

---

## Self-Review

### Spec coverage

- Native JSONL scanning, cwd validation, sidechain exclusion, dedupe, mtime prefilter, branch, and previews are covered in Task 3.
- Recent context no-truncation, expansion, long assistant skip, page markers, and Telegram HTML escaping are covered in Task 4.
- Imported `SessionData` fields and reuse-by-`sdkSessionId` are covered in Tasks 1 and 5.
- Soft lease persistence, TTL, owner masking, refresh, release, and cleanup are covered in Tasks 1 and 2.
- Telegram commands `/session`, `/session all`, `/resume`, and `/release` are covered in Tasks 6 and 7.
- Runtime switch to Claude, `/new`, `/session`, `/runtime codex`, `/stop`, `/sessions`, and `/help` behavior are covered in Task 7.
- Ordinary-message guard, guarded-message non-persistence, task-completion refresh, active-state check, and failure release are covered in Task 8.
- Metadata preservation is covered in Task 9.
- Documentation, tests, build, and manual Telegram verification are covered in Task 10.

### Placeholder scan

No task uses TBD/TODO/later placeholders. Each code-changing step includes exact file paths, code snippets, commands, and expected outcomes.

### Type consistency

The plan consistently uses:

- `SessionData.source?: 'claude-native'`
- `NativeSessionLease.sdkSessionId`
- `ClaudeNativeSessionCandidate.sessionId`
- `sourcePath`, `importedAt`, `lastNativeActivityAt`, and `nativePreview`
- `NativeCommandCandidateCache`
- `NativeSessionLeaseService`

### Implementation caution

The plan includes commit steps because the planning skill requires frequent commits. During execution in Claude Code, only run those commit steps if the user explicitly authorizes committing; otherwise treat them as checkpoints and continue with uncommitted local changes.
