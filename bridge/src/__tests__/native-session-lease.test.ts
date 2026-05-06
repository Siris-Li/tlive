import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileStore } from '../store/json-file.js';
import type { NativeSessionLease } from '../store/interface.js';
import {
  NATIVE_LEASE_TTL_MINUTES,
  NativeSessionLeaseService,
  isNativeLeaseExpired,
  maskLeaseOwner,
  nativeLeaseOwner,
} from '../native/native-session-lease.js';

const BASE_TIME = Date.parse('2026-05-06T12:00:00.000Z');

function iso(at: number): string {
  return new Date(at).toISOString();
}

function makeLease(overrides: Partial<NativeSessionLease> = {}): NativeSessionLease {
  return {
    sdkSessionId: overrides.sdkSessionId ?? 'sdk-1',
    owner: overrides.owner ?? nativeLeaseOwner('telegram', '123456789'),
    ownerUserId: overrides.ownerUserId ?? 'user-1',
    tliveSessionId: overrides.tliveSessionId ?? 'tlive-1',
    lockedAt: overrides.lockedAt ?? iso(BASE_TIME),
    lastActiveAt: overrides.lastActiveAt ?? iso(BASE_TIME),
    ttlMinutes: overrides.ttlMinutes ?? NATIVE_LEASE_TTL_MINUTES,
  };
}

describe('native session lease helpers', () => {
  it('builds and masks owners and detects lease expiration', () => {
    const owner = nativeLeaseOwner('telegram', '123456789');
    const lease = makeLease({ owner });

    expect(NATIVE_LEASE_TTL_MINUTES).toBe(30);
    expect(owner).toBe('telegram:123456789');
    expect(maskLeaseOwner(owner)).toBe('telegram:*6789');
    expect(isNativeLeaseExpired(lease, BASE_TIME + 29 * 60_000)).toBe(false);
    expect(isNativeLeaseExpired(lease, BASE_TIME + 30 * 60_000)).toBe(true);
  });
});

describe('NativeSessionLeaseService', () => {
  let tmpDir: string;
  let store: JsonFileStore;
  let service: NativeSessionLeaseService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-native-lease-'));
    store = new JsonFileStore(tmpDir);
    service = new NativeSessionLeaseService(store);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires a lease when none exists', async () => {
    const result = await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner: nativeLeaseOwner('telegram', '123456789'),
        ownerUserId: 'user-1',
        tliveSessionId: 'tlive-1',
      },
      BASE_TIME,
    );

    expect(result).toEqual({
      status: 'acquired',
      lease: makeLease(),
    });
    expect(await store.getNativeSessionLease('sdk-1')).toEqual(result.lease);
  });

  it('preserves ownerUserId and refreshes tliveSessionId when the same owner reacquires without ownerUserId', async () => {
    const owner = nativeLeaseOwner('telegram', '123456789');
    const first = await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner,
        ownerUserId: 'user-1',
        tliveSessionId: 'tlive-1',
      },
      BASE_TIME,
    );

    const second = await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner,
        tliveSessionId: 'tlive-2',
      },
      BASE_TIME + 5_000,
    );

    expect(second.status).toBe('refreshed');
    expect(second.lease.lockedAt).toBe(first.lease.lockedAt);
    expect(second.lease.lastActiveAt).toBe(iso(BASE_TIME + 5_000));
    expect(second.lease.ownerUserId).toBe('user-1');
    expect(second.lease.tliveSessionId).toBe('tlive-2');
    expect(second.lease.owner).toBe(owner);
  });

  it('blocks a different owner while the active lease is still valid', async () => {
    const first = await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner: nativeLeaseOwner('telegram', '123456789'),
        ownerUserId: 'user-1',
        tliveSessionId: 'tlive-1',
      },
      BASE_TIME,
    );

    const blocked = await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner: nativeLeaseOwner('telegram', '987654321'),
        ownerUserId: 'user-2',
        tliveSessionId: 'tlive-2',
      },
      BASE_TIME + 1_000,
    );

    expect(blocked).toEqual({
      status: 'blocked',
      lease: first.lease,
    });
  });

  it('cleans up expired leases and replaces an expired lease for a new owner', async () => {
    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-expired-1', owner: nativeLeaseOwner('telegram', '1111') }));
    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-expired-2', owner: nativeLeaseOwner('telegram', '2222') }));

    const cleaned = await service.cleanupExpired(BASE_TIME + 31 * 60_000);

    expect(cleaned).toBe(2);
    expect(await store.listNativeSessionLeases()).toEqual([]);

    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-replace', owner: nativeLeaseOwner('telegram', '3333') }));

    const acquired = await service.acquire(
      {
        sdkSessionId: 'sdk-replace',
        owner: nativeLeaseOwner('telegram', '4444'),
        ownerUserId: 'user-4',
        tliveSessionId: 'tlive-4',
      },
      BASE_TIME + 31 * 60_000,
    );

    expect(acquired).toEqual({
      status: 'acquired',
      lease: makeLease({
        sdkSessionId: 'sdk-replace',
        owner: nativeLeaseOwner('telegram', '4444'),
        ownerUserId: 'user-4',
        tliveSessionId: 'tlive-4',
        lockedAt: iso(BASE_TIME + 31 * 60_000),
        lastActiveAt: iso(BASE_TIME + 31 * 60_000),
      }),
    });
    expect(await store.getNativeSessionLease('sdk-replace')).toEqual(acquired.lease);
  });

  it('returns missing, blocked, refreshed, and expired statuses when refreshing', async () => {
    const owner = nativeLeaseOwner('telegram', '123456789');
    const otherOwner = nativeLeaseOwner('telegram', '987654321');

    expect(await service.refresh('missing-sdk', owner, BASE_TIME)).toEqual({ status: 'missing' });

    await service.acquire(
      {
        sdkSessionId: 'sdk-1',
        owner,
        ownerUserId: 'user-1',
        tliveSessionId: 'tlive-1',
      },
      BASE_TIME,
    );

    const blocked = await service.refresh('sdk-1', otherOwner, BASE_TIME + 1_000);
    expect(blocked).toEqual({
      status: 'blocked',
      lease: makeLease(),
    });

    const refreshed = await service.refresh('sdk-1', owner, BASE_TIME + 2_000);
    expect(refreshed).toEqual({
      status: 'refreshed',
      lease: makeLease({
        lastActiveAt: iso(BASE_TIME + 2_000),
      }),
    });

    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-expired', owner }));

    expect(await service.refresh('sdk-expired', otherOwner, BASE_TIME + 31 * 60_000)).toEqual({ status: 'expired' });
    expect(await store.getNativeSessionLease('sdk-expired')).toBeNull();
  });


  it('blocks non-owners from releasing and deletes expired leases on owner release', async () => {
    const owner = nativeLeaseOwner('telegram', '123456789');

    await service.acquire(
      {
        sdkSessionId: 'sdk-active',
        owner,
        ownerUserId: 'user-1',
        tliveSessionId: 'tlive-active',
      },
      BASE_TIME,
    );

    const blocked = await service.release('sdk-active', nativeLeaseOwner('telegram', '987654321'), BASE_TIME + 1_000);
    expect(blocked).toEqual({
      status: 'blocked',
      lease: makeLease({
        sdkSessionId: 'sdk-active',
        tliveSessionId: 'tlive-active',
      }),
    });

    const released = await service.release('sdk-active', owner, BASE_TIME + 2_000);
    expect(released).toEqual({
      status: 'released',
      lease: makeLease({
        sdkSessionId: 'sdk-active',
        tliveSessionId: 'tlive-active',
      }),
    });
    expect(await store.getNativeSessionLease('sdk-active')).toBeNull();

    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-expired', owner, tliveSessionId: 'tlive-expired' }));

    expect(await service.release('sdk-expired', owner, BASE_TIME + 31 * 60_000)).toEqual({ status: 'expired' });
    expect(await store.getNativeSessionLease('sdk-expired')).toBeNull();
  });

  it('returns the active lease and deletes expired leases in getActive', async () => {
    const activeLease = makeLease({ sdkSessionId: 'sdk-active' });
    await store.saveNativeSessionLease(activeLease);

    expect(await service.getActive('sdk-active', BASE_TIME + 5 * 60_000)).toEqual(activeLease);

    await store.saveNativeSessionLease(makeLease({ sdkSessionId: 'sdk-expired' }));

    expect(await service.getActive('sdk-expired', BASE_TIME + 31 * 60_000)).toBeNull();
    expect(await store.getNativeSessionLease('sdk-expired')).toBeNull();
  });
});
