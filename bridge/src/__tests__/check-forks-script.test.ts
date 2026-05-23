import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmpRoots: string[] = [];

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd: string, args: string[]): string {
  return run('git', args, cwd);
}

function commitFile(repo: string, name: string, content: string, message: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, ['add', name]);
  git(repo, ['commit', '-m', message]);
}

function configureUser(repo: string): void {
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
}

describe('check-forks.ps1', () => {
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports local/origin sync separately from origin/upstream sync', () => {
    const root = mkdtempSync(join(tmpdir(), 'tlive-check-forks-'));
    tmpRoots.push(root);

    const upstreamWork = join(root, 'upstream-work');
    const upstreamBare = join(root, 'upstream.git');
    const originBare = join(root, 'origin.git');
    const originWork = join(root, 'origin-work');
    const localRepo = join(root, 'fork-repo');

    git(root, ['init', '-b', 'main', upstreamWork]);
    configureUser(upstreamWork);
    commitFile(upstreamWork, 'shared.txt', 'base\n', 'base');
    git(root, ['clone', '--bare', upstreamWork, upstreamBare]);
    git(root, ['clone', '--bare', upstreamWork, originBare]);

    git(root, ['clone', originBare, originWork]);
    configureUser(originWork);
    commitFile(originWork, 'origin.txt', 'origin ahead\n', 'origin ahead');
    git(originWork, ['push', 'origin', 'main']);

    commitFile(upstreamWork, 'upstream-1.txt', 'upstream ahead 1\n', 'upstream ahead 1');
    commitFile(upstreamWork, 'upstream-2.txt', 'upstream ahead 2\n', 'upstream ahead 2');
    git(upstreamWork, ['push', upstreamBare, 'main']);

    git(root, ['clone', originBare, localRepo]);
    configureUser(localRepo);
    git(localRepo, ['remote', 'add', 'upstream', upstreamBare]);
    git(localRepo, ['remote', 'set-url', '--push', 'upstream', 'DISABLED']);

    commitFile(localRepo, 'local.txt', 'local ahead\n', 'local ahead');
    writeFileSync(join(localRepo, 'dirty.txt'), 'uncommitted\n');

    const script = resolve(process.cwd(), '..', 'tools', 'check-forks.ps1');
    const output = run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Root',
      root,
      '-DryRun',
    ], root);
    const payload = JSON.parse(output);

    expect(payload.summary).toContain('fork-repo');
    expect(payload.summary).toContain('local vs origin: local +1, origin +0, dirty');
    expect(payload.summary).toContain('origin vs upstream: fork +1, upstream +2');
  });
});
