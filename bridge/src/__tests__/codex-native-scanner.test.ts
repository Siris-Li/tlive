import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CODEX_JSONL_PREFILTER_LIMIT,
  CODEX_SESSION_LIST_LIMIT,
  findCodexNativeSessionById,
  scanCodexNativeSessions,
} from '../native/codex-native-scanner.js';

const BASE_TIME = Date.parse('2026-05-15T12:00:00.000Z');

function iso(offsetMinutes: number): string {
  return new Date(BASE_TIME + offsetMinutes * 60_000).toISOString();
}

function writeCodexSession(
  baseDir: string,
  sessionId: string,
  rows: Array<object | string>,
  mtimeMs = BASE_TIME,
): string {
  const sessionDir = join(baseDir, 'sessions', '2026', '05', '15');
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `rollout-2026-05-15T20-00-00-${sessionId}.jsonl`);
  const content = rows
    .map(row => (typeof row === 'string' ? row : JSON.stringify(row)))
    .join('\n');

  writeFileSync(filePath, content, 'utf8');
  utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
  return filePath;
}

describe('codex-native-scanner', () => {
  let tmpDir: string;
  let codexHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tlive-codex-scanner-'));
    codexHome = join(tmpDir, '.codex');
    mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports the expected scanner limits', () => {
    expect(CODEX_JSONL_PREFILTER_LIMIT).toBe(100);
    expect(CODEX_SESSION_LIST_LIMIT).toBe(10);
  });

  it('parses Codex session metadata, visible messages, cwd, and index title fallback', async () => {
    const cwd = join(tmpDir, 'repo');
    mkdirSync(cwd, { recursive: true });
    const sessionId = '019e2c2d-3be4-7721-81f7-0b99f57a3216';
    const sourcePath = writeCodexSession(codexHome, sessionId, [
      '{not valid json}',
      {
        timestamp: iso(-5),
        type: 'session_meta',
        payload: {
          id: sessionId,
          timestamp: iso(-5),
          cwd,
          cli_version: '0.130.0-alpha.5',
        },
      },
      {
        timestamp: iso(-4),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first codex question' }],
        },
      },
      {
        timestamp: iso(-3),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first codex answer' }],
        },
      },
      {
        timestamp: iso(-2),
        type: 'event_msg',
        payload: { type: 'token_count', message: 'hidden telemetry' },
      },
      {
        timestamp: iso(-1),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'latest codex question' }],
        },
      },
      {
        timestamp: iso(0),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'latest codex answer' }],
        },
      },
    ]);

    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({
        id: sessionId,
        thread_name: 'Index fallback title',
        updated_at: iso(2),
      }) + '\n',
      'utf8',
    );

    const [candidate] = await scanCodexNativeSessions({ codexHome });

    expect(candidate).toEqual({
      sessionId,
      sourcePath,
      cwd,
      cwdSource: 'jsonl',
      cwdExists: true,
      lastActivityAt: iso(2),
      preview: 'latest codex question',
      nativePreview: 'latest codex question',
      recentMessages: [
        { role: 'user', text: 'first codex question', timestamp: iso(-4) },
        { role: 'assistant', text: 'first codex answer', timestamp: iso(-3) },
        { role: 'user', text: 'latest codex question', timestamp: iso(-1) },
        { role: 'assistant', text: 'latest codex answer', timestamp: iso(0) },
      ],
      version: '0.130.0-alpha.5',
      isSidechain: false,
    });
  });

  it('uses the session index title when no visible user preview exists', async () => {
    const sessionId = '019e2c2d-index-title-only';
    writeCodexSession(codexHome, sessionId, [
      {
        timestamp: iso(-1),
        type: 'session_meta',
        payload: { id: sessionId, cwd: join(tmpDir, 'missing') },
      },
      {
        timestamp: iso(0),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'assistant-only visible text' }],
        },
      },
    ]);
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: sessionId, thread_name: 'Thread title from index', updated_at: iso(3) }) + '\n',
      'utf8',
    );

    const [candidate] = await scanCodexNativeSessions({ codexHome });

    expect(candidate.preview).toBe('Thread title from index');
    expect(candidate.nativePreview).toBe('Thread title from index');
    expect(candidate.lastActivityAt).toBe(iso(3));
  });

  it('finds a Codex native session by id beyond the default display limit', async () => {
    for (let index = 1; index <= 12; index += 1) {
      const sessionId = `019e2c2d-codex-${String(index).padStart(2, '0')}`;
      writeCodexSession(codexHome, sessionId, [
        {
          timestamp: iso(-index),
          type: 'session_meta',
          payload: { id: sessionId, cwd: join(tmpDir, `repo-${index}`) },
        },
        {
          timestamp: iso(-index),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `codex message ${index}` }],
          },
        },
      ]);
    }

    const scanned = await scanCodexNativeSessions({ codexHome });
    expect(scanned).toHaveLength(CODEX_SESSION_LIST_LIMIT);
    expect(scanned.some(candidate => candidate.sessionId === '019e2c2d-codex-11')).toBe(false);

    const found = await findCodexNativeSessionById('019e2c2d-codex-11', { codexHome });

    expect(found?.sessionId).toBe('019e2c2d-codex-11');
    expect(found?.preview).toBe('codex message 11');
  });
});
