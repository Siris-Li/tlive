import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { ClaudeNativeSessionCandidate, NativeCwdSource, NativeVisibleMessage } from './claude-native-scanner.js';

export const CODEX_JSONL_PREFILTER_LIMIT = 100;
export const CODEX_SESSION_LIST_LIMIT = 10;

export type CodexNativeSessionCandidate = ClaudeNativeSessionCandidate;

export interface ScanCodexNativeSessionsOptions {
  codexHome?: string;
  prefilterLimit?: number;
  limit?: number;
  cwdExists?: (path: string) => boolean;
}

interface JsonlFileInfo {
  path: string;
  mtimeMs: number;
  mtimeIso: string;
  filenameSessionId: string;
}

interface CodexIndexEntry {
  threadName?: string;
  updatedAt?: string;
}

interface ParsedVisibleMessage {
  visibleMessage?: NativeVisibleMessage;
  previewText?: string;
}

export async function scanCodexNativeSessions(
  options: ScanCodexNativeSessionsOptions = {},
): Promise<CodexNativeSessionCandidate[]> {
  const codexHome = options.codexHome ?? join(homedir(), '.codex');
  const prefilterLimit = normalizeLimit(options.prefilterLimit, CODEX_JSONL_PREFILTER_LIMIT);
  const limit = normalizeLimit(options.limit, CODEX_SESSION_LIST_LIMIT);
  const cwdExists = options.cwdExists ?? defaultCwdExists;

  if (prefilterLimit === 0 || limit === 0) {
    return [];
  }

  const files = discoverJsonlFiles(join(codexHome, 'sessions'), prefilterLimit);
  const index = readSessionIndex(codexHome);
  const parsedCandidates: CodexNativeSessionCandidate[] = [];

  for (const fileInfo of files) {
    const candidate = await parseCodexJsonlFile(fileInfo, index, cwdExists);
    if (candidate) {
      parsedCandidates.push(candidate);
    }
  }

  const deduped = dedupeCandidates(parsedCandidates);
  deduped.sort(compareCandidatesByActivityDesc);
  return deduped.slice(0, limit);
}

export async function findCodexNativeSessionById(
  sessionId: string,
  options: ScanCodexNativeSessionsOptions = {},
): Promise<CodexNativeSessionCandidate | null> {
  const prefilterLimit = normalizeLimit(options.prefilterLimit, CODEX_JSONL_PREFILTER_LIMIT);
  if (prefilterLimit === 0) {
    return null;
  }

  const candidates = await scanCodexNativeSessions({
    ...options,
    prefilterLimit,
    limit: prefilterLimit,
  });

  return candidates.find(candidate => candidate.sessionId === sessionId) ?? null;
}

function discoverJsonlFiles(baseDir: string, prefilterLimit: number): JsonlFileInfo[] {
  let baseDirStat;
  try {
    baseDirStat = statSync(baseDir);
  } catch {
    return [];
  }

  if (!baseDirStat.isDirectory()) {
    return [];
  }

  const files: JsonlFileInfo[] = [];
  const pendingDirs = [baseDir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      try {
        const stats = statSync(fullPath);
        if (!stats.isFile()) {
          continue;
        }

        files.push({
          path: fullPath,
          mtimeMs: stats.mtimeMs,
          mtimeIso: stats.mtime.toISOString(),
          filenameSessionId: parseSessionIdFromFilename(entry.name),
        });
      } catch {
        continue;
      }
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  return files.slice(0, prefilterLimit);
}

function readSessionIndex(codexHome: string): Map<string, CodexIndexEntry> {
  const entries = new Map<string, CodexIndexEntry>();
  const indexPath = join(codexHome, 'session_index.jsonl');

  let content: string;
  try {
    content = readFileSync(indexPath, 'utf8');
  } catch {
    return entries;
  }

  for (const line of content.split(/\r?\n/)) {
    const row = safeParseRecord(line);
    if (!row) {
      continue;
    }

    const id = takeNonEmptyString(row.id);
    if (!id) {
      continue;
    }

    const threadName = takeNonEmptyString(row.thread_name);
    const updatedAt = parseTimestamp(row.updated_at)?.iso;
    entries.set(id, {
      ...(threadName ? { threadName } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  return entries;
}

async function parseCodexJsonlFile(
  fileInfo: JsonlFileInfo,
  index: Map<string, CodexIndexEntry>,
  cwdExists: (path: string) => boolean,
): Promise<CodexNativeSessionCandidate | null> {
  const stream = createReadStream(fileInfo.path, { encoding: 'utf8' });
  const readlineInterface = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let sessionId: string | undefined;
  let latestCwd: string | undefined;
  let version: string | undefined;
  let latestTimestampIso: string | undefined;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;
  let latestUserPreview: string | undefined;
  let firstUserPreview: string | undefined;
  const recentMessages: NativeVisibleMessage[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      readlineInterface.on('error', reject);

      readlineInterface.on('line', line => {
        const row = safeParseRecord(line);
        if (!row) {
          return;
        }

        const timestamp = parseTimestamp(row.timestamp);
        if (timestamp && timestamp.ms >= latestTimestampMs) {
          latestTimestampMs = timestamp.ms;
          latestTimestampIso = timestamp.iso;
        }

        const payload = isRecord(row.payload) ? row.payload : undefined;
        if (row.type === 'session_meta' && payload) {
          sessionId ??= takeNonEmptyString(payload.id);
          latestCwd = takeNonEmptyString(payload.cwd) ?? latestCwd;
          version = takeNonEmptyString(payload.cli_version) ?? version;
          const payloadTimestamp = parseTimestamp(payload.timestamp);
          if (payloadTimestamp && payloadTimestamp.ms >= latestTimestampMs) {
            latestTimestampMs = payloadTimestamp.ms;
            latestTimestampIso = payloadTimestamp.iso;
          }
        }

        if (row.type === 'turn_context' && payload) {
          latestCwd = takeNonEmptyString(payload.cwd) ?? latestCwd;
        }

        const parsedMessage = extractVisibleMessage(row);
        if (!parsedMessage.visibleMessage) {
          return;
        }

        recentMessages.push(parsedMessage.visibleMessage);
        if (parsedMessage.previewText) {
          firstUserPreview ??= parsedMessage.previewText;
          latestUserPreview = parsedMessage.previewText;
        }
      });

      readlineInterface.on('close', resolve);
    });
  } catch {
    return null;
  } finally {
    readlineInterface.close();
    stream.close();
  }

  const resolvedSessionId = sessionId ?? fileInfo.filenameSessionId;
  if (!resolvedSessionId) {
    return null;
  }

  const indexEntry = index.get(resolvedSessionId);
  const indexTimestamp = parseTimestamp(indexEntry?.updatedAt);
  if (indexTimestamp && indexTimestamp.ms >= latestTimestampMs) {
    latestTimestampMs = indexTimestamp.ms;
    latestTimestampIso = indexTimestamp.iso;
  }

  const preview = latestUserPreview ?? firstUserPreview ?? indexEntry?.threadName;
  if (!preview && recentMessages.length === 0) {
    return null;
  }

  const cwdSource: NativeCwdSource = latestCwd ? 'jsonl' : 'unknown';

  return {
    sessionId: resolvedSessionId,
    sourcePath: fileInfo.path,
    ...(latestCwd ? { cwd: latestCwd } : {}),
    cwdSource,
    cwdExists: latestCwd ? safeCwdExists(cwdExists, latestCwd) : false,
    lastActivityAt: latestTimestampIso ?? fileInfo.mtimeIso,
    preview: preview ?? '(empty)',
    nativePreview: preview ?? '(empty)',
    recentMessages,
    ...(version ? { version } : {}),
    isSidechain: false,
  };
}

function extractVisibleMessage(row: Record<string, unknown>): ParsedVisibleMessage {
  if (row.type !== 'response_item') {
    return {};
  }

  const payload = isRecord(row.payload) ? row.payload : undefined;
  if (!payload || payload.type !== 'message') {
    return {};
  }

  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') {
    return {};
  }

  const text = extractVisibleText(payload.content);
  if (!text) {
    return {};
  }

  const timestamp = parseTimestamp(row.timestamp)?.iso;
  return {
    visibleMessage: {
      role,
      text,
      ...(timestamp ? { timestamp } : {}),
    },
    previewText: role === 'user' ? text : undefined,
  };
}

function extractVisibleText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const text = content.trim();
    return text || undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      const text = block.trim();
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (!isRecord(block)) {
      continue;
    }

    const type = takeNonEmptyString(block.type);
    if (type !== 'input_text' && type !== 'output_text' && type !== 'text') {
      continue;
    }

    const text = takeNonEmptyString(block.text);
    if (text) {
      textParts.push(text);
    }
  }

  return textParts.length > 0 ? textParts.join('\n') : undefined;
}

function dedupeCandidates(candidates: CodexNativeSessionCandidate[]): CodexNativeSessionCandidate[] {
  const deduped = new Map<string, CodexNativeSessionCandidate>();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.sessionId);
    if (!existing || shouldPreferCandidate(candidate, existing)) {
      deduped.set(candidate.sessionId, candidate);
    }
  }

  return [...deduped.values()];
}

function shouldPreferCandidate(
  candidate: CodexNativeSessionCandidate,
  existing: CodexNativeSessionCandidate,
): boolean {
  const candidateTime = parseTimestamp(candidate.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;
  const existingTime = parseTimestamp(existing.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;

  if (candidateTime !== existingTime) {
    return candidateTime > existingTime;
  }

  if (candidate.cwdExists !== existing.cwdExists) {
    return candidate.cwdExists;
  }

  return candidate.sourcePath.localeCompare(existing.sourcePath) > 0;
}

function compareCandidatesByActivityDesc(
  left: CodexNativeSessionCandidate,
  right: CodexNativeSessionCandidate,
): number {
  const leftTime = parseTimestamp(left.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;
  const rightTime = parseTimestamp(right.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;

  return rightTime - leftTime || Number(right.cwdExists) - Number(left.cwdExists) || right.sourcePath.localeCompare(left.sourcePath);
}

function parseSessionIdFromFilename(name: string): string {
  const withoutExt = basename(name, '.jsonl');
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/.exec(withoutExt);
  return match?.[1] ?? withoutExt;
}

function takeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTimestamp(value: unknown): { ms: number; iso: string } | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return undefined;
  }

  return {
    ms,
    iso: new Date(ms).toISOString(),
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function defaultCwdExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeCwdExists(cwdExists: (path: string) => boolean, path: string): boolean {
  try {
    return cwdExists(path) === true;
  } catch {
    return false;
  }
}

function safeParseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
