import { createReadStream, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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

export interface ScanClaudeNativeSessionsOptions {
  baseDir?: string;
  prefilterLimit?: number;
  limit?: number;
  cwdExists?: (path: string) => boolean;
}

interface JsonlFileInfo {
  path: string;
  mtimeMs: number;
  mtimeIso: string;
  filenameSessionId: string;
  projectDirName?: string;
}

interface ParsedVisibleMessage {
  visibleMessage?: NativeVisibleMessage;
  previewText?: string;
  useful: boolean;
}

const EMPTY_PREVIEW = '(empty)';
const ATTACHMENT_ONLY_PLACEHOLDER = '[附件/图片消息，未在 Telegram 最近上下文中展开]';
const ATTACHMENT_LIKE_BLOCK_TYPES = new Set([
  'image',
  'image_url',
  'document',
  'file',
  'attachment',
  'input_image',
  'input_document',
]);

export async function scanClaudeNativeSessions(
  options: ScanClaudeNativeSessionsOptions = {},
): Promise<ClaudeNativeSessionCandidate[]> {
  const baseDir = options.baseDir ?? join(homedir(), '.claude', 'projects');
  const prefilterLimit = normalizeLimit(options.prefilterLimit, CLAUDE_JSONL_PREFILTER_LIMIT);
  const limit = normalizeLimit(options.limit, CLAUDE_SESSION_LIST_LIMIT);
  const cwdExists = options.cwdExists ?? defaultCwdExists;

  if (prefilterLimit === 0 || limit === 0) {
    return [];
  }

  const files = discoverJsonlFiles(baseDir, prefilterLimit);
  const parsedCandidates: ClaudeNativeSessionCandidate[] = [];

  for (const fileInfo of files) {
    const candidate = await parseJsonlFile(fileInfo, cwdExists);
    if (!candidate || candidate.isSidechain) {
      continue;
    }

    parsedCandidates.push(candidate);
  }

  const deduped = dedupeCandidates(parsedCandidates);
  deduped.sort(compareCandidatesByActivityDesc);
  return deduped.slice(0, limit);
}

export async function findClaudeNativeSessionById(
  sessionId: string,
  options: ScanClaudeNativeSessionsOptions = {},
): Promise<ClaudeNativeSessionCandidate | null> {
  const prefilterLimit = normalizeLimit(options.prefilterLimit, CLAUDE_JSONL_PREFILTER_LIMIT);
  if (prefilterLimit === 0) {
    return null;
  }

  const candidates = await scanClaudeNativeSessions({
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

        const relativeDir = relative(baseDir, dirname(fullPath));
        const firstRelativeSegment = relativeDir.split(/[\\/]/).find(segment => segment.length > 0);

        files.push({
          path: fullPath,
          mtimeMs: stats.mtimeMs,
          mtimeIso: stats.mtime.toISOString(),
          filenameSessionId: basename(fullPath, '.jsonl'),
          projectDirName: firstRelativeSegment,
        });
      } catch {
        continue;
      }
    }
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  return files.slice(0, prefilterLimit);
}

async function parseJsonlFile(
  fileInfo: JsonlFileInfo,
  cwdExists: (path: string) => boolean,
): Promise<ClaudeNativeSessionCandidate | null> {
  const stream = createReadStream(fileInfo.path, { encoding: 'utf8' });
  const readlineInterface = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let firstSessionId: string | undefined;
  let latestCwd: string | undefined;
  let latestTimestampIso: string | undefined;
  let latestTimestampMs = Number.NEGATIVE_INFINITY;
  let latestUserPreview: string | undefined;
  let firstUserPreview: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let usefulRows = 0;
  let sidechainRows = 0;
  const recentMessages: NativeVisibleMessage[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      readlineInterface.on('error', reject);

      readlineInterface.on('line', line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          return;
        }

        const row = safeParseRecord(trimmedLine);
        if (!row) {
          return;
        }

        const rowSessionId = takeNonEmptyString(row.sessionId);
        if (!firstSessionId && rowSessionId) {
          firstSessionId = rowSessionId;
        }

        const timestamp = parseTimestamp(row.timestamp);
        if (timestamp && timestamp.ms >= latestTimestampMs) {
          latestTimestampMs = timestamp.ms;
          latestTimestampIso = timestamp.iso;
        }

        const rowCwd = takeNonEmptyString(row.cwd);
        if (rowCwd) {
          latestCwd = rowCwd;
        }

        const rowGitBranch = takeNonEmptyString(row.gitBranch);
        if (rowGitBranch) {
          gitBranch = rowGitBranch;
        }

        const rowVersion = takeNonEmptyString(row.version);
        if (rowVersion) {
          version = rowVersion;
        }

        if (shouldSkipRow(row)) {
          return;
        }

        const message = getMessageRecord(row);
        if (!message) {
          return;
        }

        const parsedMessage = extractVisibleMessage(message, timestamp?.iso);
        if (!parsedMessage.visibleMessage) {
          return;
        }

        recentMessages.push(parsedMessage.visibleMessage);
        if (parsedMessage.useful) {
          usefulRows += 1;
        }

        if (parsedMessage.previewText) {
          firstUserPreview ??= parsedMessage.previewText;
          latestUserPreview = parsedMessage.previewText;
        }

        if (isSidechainRecord(row) || isSidechainRecord(message)) {
          sidechainRows += 1;
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

  if (usefulRows === 0) {
    return null;
  }

  const sessionId = firstSessionId ?? fileInfo.filenameSessionId;
  if (!sessionId) {
    return null;
  }

  const derivedCwd = latestCwd ?? deriveCwdFromProjectDirName(fileInfo.projectDirName);
  const cwdSource: NativeCwdSource = latestCwd ? 'jsonl' : derivedCwd ? 'project-dir' : 'unknown';
  const cwdExistsValue = derivedCwd ? safeCwdExists(cwdExists, derivedCwd) : false;
  const preview = latestUserPreview ?? firstUserPreview ?? EMPTY_PREVIEW;
  const isSidechain = usefulRows > 0 && sidechainRows >= usefulRows;

  return {
    sessionId,
    sourcePath: fileInfo.path,
    cwdSource,
    cwdExists: cwdExistsValue,
    lastActivityAt: latestTimestampIso ?? fileInfo.mtimeIso,
    preview,
    nativePreview: preview,
    recentMessages,
    isSidechain,
    ...(derivedCwd ? { cwd: derivedCwd } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(version ? { version } : {}),
    ...(firstSessionId && firstSessionId !== fileInfo.filenameSessionId
      ? {
          filenameSessionId: fileInfo.filenameSessionId,
          sessionIdMismatch: true,
        }
      : {}),
  };
}


function dedupeCandidates(candidates: ClaudeNativeSessionCandidate[]): ClaudeNativeSessionCandidate[] {
  const deduped = new Map<string, ClaudeNativeSessionCandidate>();

  for (const candidate of candidates) {
    const existing = deduped.get(candidate.sessionId);
    if (!existing || shouldPreferCandidate(candidate, existing)) {
      deduped.set(candidate.sessionId, candidate);
    }
  }

  return [...deduped.values()];
}

function shouldPreferCandidate(
  candidate: ClaudeNativeSessionCandidate,
  existing: ClaudeNativeSessionCandidate,
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
  left: ClaudeNativeSessionCandidate,
  right: ClaudeNativeSessionCandidate,
): number {
  const leftTime = parseTimestamp(left.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;
  const rightTime = parseTimestamp(right.lastActivityAt)?.ms ?? Number.NEGATIVE_INFINITY;

  return rightTime - leftTime || Number(right.cwdExists) - Number(left.cwdExists) || right.sourcePath.localeCompare(left.sourcePath);
}

function shouldSkipRow(row: Record<string, unknown>): boolean {
  return (
    row.type === 'system' ||
    row.isMeta === true ||
    row.isCompactSummary === true ||
    row.toolUseResult !== undefined
  );
}

function getMessageRecord(row: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(row.message)) {
    return row.message;
  }

  if (row.role === 'user' || row.role === 'assistant') {
    return row;
  }

  return null;
}

function extractVisibleMessage(
  message: Record<string, unknown>,
  timestamp?: string,
): ParsedVisibleMessage {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant') {
    return { useful: false };
  }

  const text = extractVisibleText(message.content);
  if (text) {
    return {
      visibleMessage: {
        role,
        text,
        ...(timestamp ? { timestamp } : {}),
      },
      previewText: role === 'user' ? text : undefined,
      useful: true,
    };
  }

  if (role === 'user' && isAttachmentLikeUserContent(message.content)) {
    return {
      visibleMessage: {
        role,
        text: ATTACHMENT_ONLY_PLACEHOLDER,
        ...(timestamp ? { timestamp } : {}),
      },
      useful: true,
    };
  }

  return { useful: false };
}

function isAttachmentLikeUserContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }

  return content.some(block => isAttachmentLikeBlock(block));
}

function isAttachmentLikeBlock(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }

  const type = takeNonEmptyString(block.type);
  if (!type) {
    return false;
  }

  if (ATTACHMENT_LIKE_BLOCK_TYPES.has(type)) {
    return true;
  }

  const source = takeNonEmptyString(block.source);
  return Boolean(source) && /(image|document|file|attachment)/i.test(type);
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

    if (!isRecord(block) || block.type !== 'text') {
      continue;
    }

    const blockText = takeNonEmptyString(block.text) ?? takeNonEmptyString(block.content);
    if (blockText) {
      textParts.push(blockText);
    }
  }

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join('\n');
}

export function deriveCwdFromProjectDirName(projectDirName?: string): string | undefined {
  if (!projectDirName || !projectDirName.includes('--')) {
    return undefined;
  }

  const segments = projectDirName.split('--');
  if (segments.length < 2 || !/^[A-Za-z]$/.test(segments[0] ?? '')) {
    return undefined;
  }

  const [driveLetter, ...rest] = segments;
  if (
    rest.some(
      segment =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\'),
    )
  ) {
    return undefined;
  }

  return `${driveLetter}:\\${rest.join('\\')}`;
}

function isSidechainRecord(record: Record<string, unknown>): boolean {
  if (record.isSidechain === true || record.sidechain === true || record.isSideChain === true) {
    return true;
  }

  if (isRecord(record.meta)) {
    return isSidechainRecord(record.meta);
  }

  return false;
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
