import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as nativeScanner from '../native/claude-native-scanner.js';
import {
  CLAUDE_JSONL_PREFILTER_LIMIT,
  CLAUDE_SESSION_LIST_LIMIT,
  findClaudeNativeSessionById,
  scanClaudeNativeSessions,
} from '../native/claude-native-scanner.js';

const BASE_TIME = Date.parse('2026-05-06T12:00:00.000Z');

function iso(offsetMinutes: number): string {
  return new Date(BASE_TIME + offsetMinutes * 60_000).toISOString();
}

function writeJsonlFile(
  baseDir: string,
  projectDirName: string,
  filename: string,
  rows: Array<object | string>,
  mtimeMs = BASE_TIME,
): string {
  const projectDir = join(baseDir, projectDirName);
  mkdirSync(projectDir, { recursive: true });

  const filePath = join(projectDir, `${filename}.jsonl`);
  const content = rows
    .map(row => (typeof row === 'string' ? row : JSON.stringify(row)))
    .join('\n');

  writeFileSync(filePath, content, 'utf8');
  utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  return filePath;
}

describe('claude-native-scanner', () => {
  let tmpDir: string;
  let baseDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-native-scanner-'));
    baseDir = join(tmpDir, 'projects');
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports the expected scanner limits', () => {
    expect(CLAUDE_JSONL_PREFILTER_LIMIT).toBe(100);
    expect(CLAUDE_SESSION_LIST_LIMIT).toBe(10);
  });

  it('parses sessionId, cwd, preview, timestamp, branch, version, and recent visible messages', async () => {
    const cwd = join(tmpDir, 'repo');
    mkdirSync(cwd, { recursive: true });

    writeJsonlFile(
      baseDir,
      'D--SirisLi--GitHub--ignored',
      'filename-session',
      [
        '{not valid json}',
        {
          type: 'system',
          sessionId: 'session-from-jsonl',
          timestamp: iso(-6),
          message: { role: 'assistant', content: 'ignored system row' },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(-5),
          cwd,
          gitBranch: 'main',
          version: '1.0.0',
          message: { role: 'user', content: 'first question' },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(-4),
          isMeta: true,
          message: { role: 'assistant', content: 'ignored meta row' },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(-3),
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'hidden thinking' },
              { type: 'text', text: 'first answer' },
            ],
          },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(-2),
          toolUseResult: { ok: true },
          message: { role: 'assistant', content: 'ignored tool result row' },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(-1),
          gitBranch: 'feature/native-resume',
          version: '1.0.1',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'latest question' },
              { type: 'image', source: 'attachment.png' },
            ],
          },
        },
        {
          sessionId: 'session-from-jsonl',
          timestamp: iso(0),
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'latest answer' },
              { type: 'tool_result', content: 'ignore this block' },
            ],
          },
        },
      ],
      BASE_TIME - 120_000,
    );

    const [candidate] = await scanClaudeNativeSessions({ baseDir });

    expect(candidate).toEqual({
      sessionId: 'session-from-jsonl',
      sourcePath: join(baseDir, 'D--SirisLi--GitHub--ignored', 'filename-session.jsonl'),
      cwd,
      cwdSource: 'jsonl',
      cwdExists: true,
      lastActivityAt: iso(0),
      preview: 'latest question',
      nativePreview: 'latest question',
      recentMessages: [
        { role: 'user', text: 'first question', timestamp: iso(-5) },
        { role: 'assistant', text: 'first answer', timestamp: iso(-3) },
        { role: 'user', text: 'latest question', timestamp: iso(-1) },
        { role: 'assistant', text: 'latest answer', timestamp: iso(0) },
      ],
      gitBranch: 'feature/native-resume',
      version: '1.0.1',
      isSidechain: false,
      filenameSessionId: 'filename-session',
      sessionIdMismatch: true,
    });
  });

  it('derives cwd from the project directory name with an injected existence callback', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--tlive', 'derived-cwd', [
      {
        sessionId: 'derived-cwd',
        timestamp: iso(0),
        message: { role: 'user', content: 'hello from derived cwd' },
      },
    ]);

    const [candidate] = await scanClaudeNativeSessions({
      baseDir,
      cwdExists: path => path === 'D:\\SirisLi\\GitHub\\tlive',
    });

    expect(candidate.cwd).toBe('D:\\SirisLi\\GitHub\\tlive');
    expect(candidate.cwdSource).toBe('project-dir');
    expect(candidate.cwdExists).toBe(true);
  });

  it('requires cwd to exist when computing cwdExists', async () => {
    const existingCwd = join(tmpDir, 'existing-cwd');
    mkdirSync(existingCwd, { recursive: true });
    const missingCwd = join(tmpDir, 'missing-cwd');

    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'existing', [
      {
        sessionId: 'existing',
        timestamp: iso(-1),
        cwd: existingCwd,
        message: { role: 'user', content: 'existing cwd session' },
      },
    ]);

    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'missing', [
      {
        sessionId: 'missing',
        timestamp: iso(0),
        cwd: missingCwd,
        message: { role: 'user', content: 'missing cwd session' },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir, limit: 20 });
    const byId = new Map(candidates.map(candidate => [candidate.sessionId, candidate]));

    expect(byId.get('existing')?.cwdExists).toBe(true);
    expect(byId.get('missing')?.cwdExists).toBe(false);
  });

  it('deduplicates by session id and prefers an existing cwd on timestamp ties', async () => {
    const preferredCwd = join(tmpDir, 'preferred-cwd');
    mkdirSync(preferredCwd, { recursive: true });

    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo-a', 'duplicate-a', [
      {
        sessionId: 'duplicate-session',
        timestamp: iso(0),
        cwd: join(tmpDir, 'missing-preferred-cwd'),
        message: { role: 'user', content: 'older duplicate' },
      },
    ]);

    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo-b', 'duplicate-b', [
      {
        sessionId: 'duplicate-session',
        timestamp: iso(0),
        cwd: preferredCwd,
        message: { role: 'user', content: 'preferred duplicate' },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir, limit: 20 });
    const duplicates = candidates.filter(candidate => candidate.sessionId === 'duplicate-session');

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.cwdExists).toBe(true);
    expect(duplicates[0]?.preview).toBe('preferred duplicate');
    expect(duplicates[0]?.sourcePath).toBe(join(baseDir, 'D--SirisLi--GitHub--repo-b', 'duplicate-b.jsonl'));
  });

  it('excludes obvious sidechain sessions', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'sidechain', [
      {
        sessionId: 'sidechain-session',
        timestamp: iso(-1),
        isSidechain: true,
        message: { role: 'user', content: 'sidechain request' },
      },
      {
        sessionId: 'sidechain-session',
        timestamp: iso(0),
        isSidechain: true,
        message: { role: 'assistant', content: 'sidechain response' },
      },
    ]);

    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'normal', [
      {
        sessionId: 'normal-session',
        timestamp: iso(0),
        message: { role: 'user', content: 'normal request' },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir, limit: 20 });

    expect(candidates.map(candidate => candidate.sessionId)).toEqual(['normal-session']);
    expect(candidates[0]?.isSidechain).toBe(false);
  });

  it('tolerates malformed JSONL rows', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'malformed', [
      '{bad json}',
      {
        sessionId: 'malformed-session',
        timestamp: iso(0),
        message: { role: 'user', content: 'still parsed' },
      },
    ]);

    const [candidate] = await scanClaudeNativeSessions({ baseDir });

    expect(candidate.sessionId).toBe('malformed-session');
    expect(candidate.preview).toBe('still parsed');
  });

  it('skips empty JSONL files without useful metadata', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'empty-session', []);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('skips JSONL files when every row is malformed', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'all-malformed', [
      '{bad json}',
      'not json at all',
      '{"unterminated": true',
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('skips parseable metadata-only rows even when they include a sessionId', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'generic-metadata-only', [
      {
        sessionId: 'generic-metadata-only',
        timestamp: iso(0),
        cwd: join(tmpDir, 'generic-cwd'),
        gitBranch: 'main',
        version: '1.0.0',
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('skips parseable JSONL files with only skipped system/meta rows even when they include a sessionId', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'skipped-rows-only', [
      {
        type: 'system',
        sessionId: 'skipped-rows-only',
        timestamp: iso(-1),
        cwd: join(tmpDir, 'hidden-cwd'),
        message: { role: 'assistant', content: 'hidden system row' },
      },
      {
        isMeta: true,
        sessionId: 'skipped-rows-only',
        timestamp: iso(0),
        message: { role: 'assistant', content: 'hidden meta row' },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('skips parseable JSONL files with only hidden or non-visible rows and no Claude-like session signal', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'hidden-only', [
      {
        timestamp: iso(-1),
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', text: 'hidden thinking' }],
        },
      },
      {
        timestamp: iso(0),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_result', content: 'hidden tool result' }],
        },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('uses filename fallback when a visible message exists without a JSONL sessionId', async () => {
    const cwd = join(tmpDir, 'filename-fallback-cwd');
    mkdirSync(cwd, { recursive: true });

    const sourcePath = writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'filename-fallback', [
      {
        timestamp: iso(0),
        cwd,
        gitBranch: 'main',
        message: { role: 'user', content: 'use filename fallback' },
      },
    ]);

    const [candidate] = await scanClaudeNativeSessions({ baseDir });

    expect(candidate).toEqual(
      expect.objectContaining({
        sessionId: 'filename-fallback',
        sourcePath,
        cwd,
        cwdSource: 'jsonl',
        cwdExists: true,
        lastActivityAt: iso(0),
        preview: 'use filename fallback',
        nativePreview: 'use filename fallback',
        gitBranch: 'main',
      }),
    );
  });

  it('does not derive cwd from suspicious project directory names', async () => {
    writeJsonlFile(baseDir, 'D--foo--..--bar', 'suspicious-dotdot', [
      {
        sessionId: 'suspicious-dotdot',
        timestamp: iso(-2),
        message: { role: 'user', content: 'no derived cwd here' },
      },
    ]);

    writeJsonlFile(baseDir, 'D--foo--.--bar', 'suspicious-dot', [
      {
        sessionId: 'suspicious-dot',
        timestamp: iso(-1),
        message: { role: 'user', content: 'still no derived cwd' },
      },
    ]);

    writeJsonlFile(baseDir, 'D----foo', 'suspicious-empty-segment', [
      {
        sessionId: 'suspicious-empty-segment',
        timestamp: iso(0),
        message: { role: 'user', content: 'empty segment should not derive cwd' },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir, limit: 20 });
    const byId = new Map(candidates.map(candidate => [candidate.sessionId, candidate]));

    expect(byId.get('suspicious-dotdot')).toEqual(
      expect.objectContaining({
        cwdSource: 'unknown',
        cwdExists: false,
      }),
    );
    expect(byId.get('suspicious-dotdot')?.cwd).toBeUndefined();
    expect(byId.get('suspicious-dot')).toEqual(
      expect.objectContaining({
        cwdSource: 'unknown',
        cwdExists: false,
      }),
    );
    expect(byId.get('suspicious-dot')?.cwd).toBeUndefined();
    expect(byId.get('suspicious-empty-segment')).toEqual(
      expect.objectContaining({
        cwdSource: 'unknown',
        cwdExists: false,
      }),
    );
    expect(byId.get('suspicious-empty-segment')?.cwd).toBeUndefined();
  });

  it('rejects suspicious path segments when deriving cwd from a project directory name', () => {
    expect(nativeScanner.deriveCwdFromProjectDirName('D--SirisLi--GitHub--tlive')).toBe('D:\\SirisLi\\GitHub\\tlive');
    expect(nativeScanner.deriveCwdFromProjectDirName('D--foo--..--bar')).toBeUndefined();
    expect(nativeScanner.deriveCwdFromProjectDirName('D--foo--.--bar')).toBeUndefined();
    expect(nativeScanner.deriveCwdFromProjectDirName('D----foo')).toBeUndefined();
    expect(nativeScanner.deriveCwdFromProjectDirName('D--foo/bar')).toBeUndefined();
    expect(nativeScanner.deriveCwdFromProjectDirName('D--foo\\bar')).toBeUndefined();
  });

  it('prefers JSONL cwd when the project directory name has an empty segment', async () => {
    const cwd = join(tmpDir, 'jsonl-cwd-wins');
    mkdirSync(cwd, { recursive: true });

    writeJsonlFile(baseDir, 'D----foo', 'jsonl-cwd-wins', [
      {
        sessionId: 'jsonl-cwd-wins',
        timestamp: iso(0),
        cwd,
        message: { role: 'user', content: 'jsonl cwd should win' },
      },
    ]);

    const [candidate] = await scanClaudeNativeSessions({ baseDir });

    expect(candidate.cwd).toBe(cwd);
    expect(candidate.cwdSource).toBe('jsonl');
    expect(candidate.cwdExists).toBe(true);
  });

  it('orders sessions by the latest JSONL timestamp instead of file mtime', async () => {
    writeJsonlFile(
      baseDir,
      'D--SirisLi--GitHub--repo',
      'newer-mtime-older-jsonl',
      [
        {
          sessionId: 'older-jsonl',
          timestamp: iso(-10),
          message: { role: 'user', content: 'older transcript activity' },
        },
      ],
      BASE_TIME + 120_000,
    );

    writeJsonlFile(
      baseDir,
      'D--SirisLi--GitHub--repo',
      'older-mtime-newer-jsonl',
      [
        {
          sessionId: 'newer-jsonl',
          timestamp: iso(0),
          message: { role: 'user', content: 'newer transcript activity' },
        },
      ],
      BASE_TIME - 120_000,
    );

    const candidates = await scanClaudeNativeSessions({ baseDir, prefilterLimit: 2, limit: 2 });

    expect(candidates.map(candidate => candidate.sessionId)).toEqual(['newer-jsonl', 'older-jsonl']);
  });

  it('finds a native session by id beyond the default display limit', async () => {
    for (let index = 1; index <= 12; index += 1) {
      writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', `session-${index}`, [
        {
          sessionId: `session-${index}`,
          timestamp: iso(-index),
          message: { role: 'user', content: `message ${index}` },
        },
      ]);
    }

    const scanned = await scanClaudeNativeSessions({ baseDir });
    expect(scanned).toHaveLength(CLAUDE_SESSION_LIST_LIMIT);
    expect(scanned.some(candidate => candidate.sessionId === 'session-11')).toBe(false);

    const found = await findClaudeNativeSessionById('session-11', { baseDir });

    expect(found?.sessionId).toBe('session-11');
    expect(found?.preview).toBe('message 11');
  });

  it('does not treat hidden structured user blocks as attachment-only content', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'hidden-structured-user', [
      {
        sessionId: 'hidden-structured-user',
        timestamp: iso(0),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'hidden tool result' },
            { type: 'tool_use', name: 'search' },
            { type: 'thinking', text: 'hidden thinking' },
            { type: 'text', text: '   ' },
            { foo: 'bar' },
          ],
        },
      },
    ]);

    const candidates = await scanClaudeNativeSessions({ baseDir });

    expect(candidates).toEqual([]);
  });

  it('uses the attachment-only placeholder for user rows without text', async () => {
    writeJsonlFile(baseDir, 'D--SirisLi--GitHub--repo', 'attachment-only', [
      {
        sessionId: 'attachment-only',
        timestamp: iso(-1),
        message: {
          role: 'user',
          content: [{ type: 'image', source: 'attachment.png' }],
        },
      },
      {
        sessionId: 'attachment-only',
        timestamp: iso(0),
        message: { role: 'assistant', content: 'I received the attachment.' },
      },
    ]);

    const [candidate] = await scanClaudeNativeSessions({ baseDir });

    expect(candidate.preview).toBe('(empty)');
    expect(candidate.recentMessages).toEqual([
      { role: 'user', text: '[附件/图片消息，未在 Telegram 最近上下文中展开]', timestamp: iso(-1) },
      { role: 'assistant', text: 'I received the attachment.', timestamp: iso(0) },
    ]);
  });
});
