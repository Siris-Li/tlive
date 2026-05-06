import type { BridgeStore, NativeSessionLease } from '../store/interface.js';

export const NATIVE_LEASE_TTL_MINUTES = 30;

export function nativeLeaseOwner(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

export function maskLeaseOwner(owner: string): string {
  const separatorIndex = owner.indexOf(':');
  if (separatorIndex === -1) {
    return `*${owner.slice(-4)}`;
  }

  const channelType = owner.slice(0, separatorIndex);
  const rawOwnerId = owner.slice(separatorIndex + 1);
  return `${channelType}:*${rawOwnerId.slice(-4)}`;
}

export function isNativeLeaseExpired(lease: NativeSessionLease, now = Date.now()): boolean {
  const lastActiveAt = Date.parse(lease.lastActiveAt);
  if (Number.isNaN(lastActiveAt)) {
    return true;
  }

  return lastActiveAt + lease.ttlMinutes * 60_000 <= now;
}

export type NativeLeaseAcquireResult =
  | { status: 'acquired'; lease: NativeSessionLease }
  | { status: 'refreshed'; lease: NativeSessionLease }
  | { status: 'blocked'; lease: NativeSessionLease };

export type NativeLeaseRefreshResult =
  | { status: 'refreshed'; lease: NativeSessionLease }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'blocked'; lease: NativeSessionLease };

export type NativeLeaseReleaseResult =
  | { status: 'released'; lease: NativeSessionLease }
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'blocked'; lease: NativeSessionLease };

export class NativeSessionLeaseService {
  constructor(private readonly store: BridgeStore) {}

  async cleanupExpired(now = Date.now()): Promise<number> {
    const leases = await this.store.listNativeSessionLeases();
    let deleted = 0;

    for (const lease of leases) {
      if (!isNativeLeaseExpired(lease, now)) {
        continue;
      }

      await this.store.deleteNativeSessionLease(lease.sdkSessionId);
      deleted += 1;
    }

    return deleted;
  }

  async getActive(sdkSessionId: string, now = Date.now()): Promise<NativeSessionLease | null> {
    const lease = await this.store.getNativeSessionLease(sdkSessionId);
    if (!lease) {
      return null;
    }

    if (isNativeLeaseExpired(lease, now)) {
      await this.store.deleteNativeSessionLease(sdkSessionId);
      return null;
    }

    return lease;
  }

  async acquire(
    params: {
      sdkSessionId: string;
      owner: string;
      ownerUserId?: string;
      tliveSessionId: string;
    },
    now = Date.now(),
  ): Promise<NativeLeaseAcquireResult> {
    const existing = await this.store.getNativeSessionLease(params.sdkSessionId);
    if (!existing || isNativeLeaseExpired(existing, now)) {
      if (existing) {
        await this.store.deleteNativeSessionLease(params.sdkSessionId);
      }

      const lease = this.buildLease(params, now);
      await this.store.saveNativeSessionLease(lease);
      return { status: 'acquired', lease };
    }

    if (existing.owner !== params.owner) {
      return { status: 'blocked', lease: existing };
    }

    const lease: NativeSessionLease = {
      ...existing,
      ownerUserId: params.ownerUserId ?? existing.ownerUserId,
      tliveSessionId: params.tliveSessionId,
      lastActiveAt: this.toIso(now),
      ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
    };
    await this.store.saveNativeSessionLease(lease);
    return { status: 'refreshed', lease };
  }

  async refresh(sdkSessionId: string, owner: string, now = Date.now()): Promise<NativeLeaseRefreshResult> {
    const existing = await this.store.getNativeSessionLease(sdkSessionId);
    if (!existing) {
      return { status: 'missing' };
    }

    if (isNativeLeaseExpired(existing, now)) {
      await this.store.deleteNativeSessionLease(sdkSessionId);
      return { status: 'expired' };
    }

    if (existing.owner !== owner) {
      return { status: 'blocked', lease: existing };
    }

    const lease: NativeSessionLease = {
      ...existing,
      lastActiveAt: this.toIso(now),
      ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
    };
    await this.store.saveNativeSessionLease(lease);
    return { status: 'refreshed', lease };
  }

  async release(sdkSessionId: string, owner: string, now = Date.now()): Promise<NativeLeaseReleaseResult> {
    const existing = await this.store.getNativeSessionLease(sdkSessionId);
    if (!existing) {
      return { status: 'missing' };
    }

    if (existing.owner !== owner) {
      return { status: 'blocked', lease: existing };
    }

    if (isNativeLeaseExpired(existing, now)) {
      await this.store.deleteNativeSessionLease(sdkSessionId);
      return { status: 'expired' };
    }

    await this.store.deleteNativeSessionLease(sdkSessionId);
    return { status: 'released', lease: existing };
  }

  private buildLease(
    params: {
      sdkSessionId: string;
      owner: string;
      ownerUserId?: string;
      tliveSessionId: string;
    },
    now: number,
  ): NativeSessionLease {
    const timestamp = this.toIso(now);
    return {
      sdkSessionId: params.sdkSessionId,
      owner: params.owner,
      ownerUserId: params.ownerUserId,
      tliveSessionId: params.tliveSessionId,
      lockedAt: timestamp,
      lastActiveAt: timestamp,
      ttlMinutes: NATIVE_LEASE_TTL_MINUTES,
    };
  }

  private toIso(now: number): string {
    return new Date(now).toISOString();
  }
}
