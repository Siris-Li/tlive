import type { ClaudeNativeSessionCandidate } from './claude-native-scanner.js';
import type { BridgeStore, SessionData } from '../store/interface.js';

export interface ImportClaudeNativeSessionOptions {
  cwdOverride?: string;
}

export async function findImportedSessionBySdkSessionId(
  store: BridgeStore,
  sdkSessionId: string,
): Promise<SessionData | null> {
  const sessions = await store.listSessions();
  return sessions.find(session => session.source === 'claude-native' && session.sdkSessionId === sdkSessionId) ?? null;
}

export async function importClaudeNativeSession(
  store: BridgeStore,
  candidate: ClaudeNativeSessionCandidate,
  options: ImportClaudeNativeSessionOptions = {},
): Promise<SessionData> {
  const existing = await findImportedSessionBySdkSessionId(store, candidate.sessionId);
  const workingDirectory = options.cwdOverride ?? candidate.cwd ?? existing?.workingDirectory ?? '';

  const session = existing
    ? {
        ...existing,
        workingDirectory,
        sdkSessionId: candidate.sessionId,
        source: 'claude-native' as const,
        sourcePath: candidate.sourcePath,
        lastNativeActivityAt: candidate.lastActivityAt,
        nativePreview: candidate.nativePreview,
      }
    : buildImportedSession(candidate, workingDirectory);

  await store.saveSession(session);
  return session;
}

function buildImportedSession(
  candidate: ClaudeNativeSessionCandidate,
  workingDirectory: string,
): SessionData {
  const now = new Date();
  const nowIso = now.toISOString();

  return {
    id: `session-imported-${candidate.sessionId.slice(-8)}-${now.getTime()}`,
    workingDirectory,
    sdkSessionId: candidate.sessionId,
    source: 'claude-native',
    sourcePath: candidate.sourcePath,
    importedAt: nowIso,
    lastNativeActivityAt: candidate.lastActivityAt,
    nativePreview: candidate.nativePreview,
    createdAt: nowIso,
  };
}
