import type { ClaudeNativeSessionCandidate } from './claude-native-scanner.js';
import type { BridgeStore, SessionData } from '../store/interface.js';

type NativeSessionSource = NonNullable<SessionData['source']>;

export interface ImportClaudeNativeSessionOptions {
  cwdOverride?: string;
}

export async function findImportedSessionBySdkSessionId(
  store: BridgeStore,
  sdkSessionId: string,
  source: NativeSessionSource = 'claude-native',
): Promise<SessionData | null> {
  const sessions = await store.listSessions();
  return sessions.find(session => session.source === source && session.sdkSessionId === sdkSessionId) ?? null;
}

export async function importNativeSession(
  store: BridgeStore,
  candidate: ClaudeNativeSessionCandidate,
  source: NativeSessionSource,
  options: ImportClaudeNativeSessionOptions = {},
): Promise<SessionData> {
  const existing = await findImportedSessionBySdkSessionId(store, candidate.sessionId, source);
  const workingDirectory = options.cwdOverride ?? candidate.cwd ?? existing?.workingDirectory ?? '';

  const session = existing
    ? {
        ...existing,
        workingDirectory,
        sdkSessionId: candidate.sessionId,
        source,
        sourcePath: candidate.sourcePath,
        lastNativeActivityAt: candidate.lastActivityAt,
        nativePreview: candidate.nativePreview,
      }
    : buildImportedSession(candidate, workingDirectory, source);

  await store.saveSession(session);
  return session;
}

export async function importClaudeNativeSession(
  store: BridgeStore,
  candidate: ClaudeNativeSessionCandidate,
  options: ImportClaudeNativeSessionOptions = {},
): Promise<SessionData> {
  return importNativeSession(store, candidate, 'claude-native', options);
}

export async function importCodexNativeSession(
  store: BridgeStore,
  candidate: ClaudeNativeSessionCandidate,
  options: ImportClaudeNativeSessionOptions = {},
): Promise<SessionData> {
  return importNativeSession(store, candidate, 'codex-native', options);
}

function buildImportedSession(
  candidate: ClaudeNativeSessionCandidate,
  workingDirectory: string,
  source: NativeSessionSource,
): SessionData {
  const now = new Date();
  const nowIso = now.toISOString();

  return {
    id: `session-imported-${candidate.sessionId.slice(-8)}-${now.getTime()}`,
    workingDirectory,
    sdkSessionId: candidate.sessionId,
    source,
    sourcePath: candidate.sourcePath,
    importedAt: nowIso,
    lastNativeActivityAt: candidate.lastActivityAt,
    nativePreview: candidate.nativePreview,
    createdAt: nowIso,
  };
}
