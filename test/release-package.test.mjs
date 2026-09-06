import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const playPath = path.join(root, 'rote', 'prove-the-ticket', 'main.ts');
const runnerPath = path.join(root, 'rote', 'prove-the-ticket', 'resources', 'run-proof.mjs');

test('declares the public 0.1 Rote contract and required confirmations', async () => {
  const play = await fs.readFile(playPath, 'utf8');

  for (const phrase of [
    'Green tests don’t prove you checked the right GitHub issue against the right code',
    'Point this at a public issue URL and your local Node project',
    'It shows the checks, you approve, then it runs them in a sandbox with no internet',
    'prints a short result card',
    'Linux + Node only for now',
    'It never writes to GitHub',
    'Public GitHub issue link',
    'Absolute path to your local Node project',
    'Type yes after you review the criteria',
    'Type yes after you review the command plan',
  ]) {
    assert.match(play, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), phrase);
  }

  for (const parameter of ['issue_url', 'checkout_path', 'confirm_criteria', 'approve_plan']) {
    assert.match(play, new RegExp(`name: ${parameter}`));
  }
  assert.match(play, /@resource\{run-proof\.mjs\}/);
  assert.match(play, /version: 0\.1\.3/);
});

test('runs the packaged runner against a Node checkout that has no prove-the-ticket sources', async () => {
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {tmpdir} = await import('node:os');
  const execFileAsync = promisify(execFile);
  const fixtureRoot = await fs.mkdtemp(path.join(tmpdir(), 'prove-ticket-external-'));

  try {
    await fs.writeFile(path.join(fixtureRoot, 'package.json'), '{"name":"external","scripts":{"test":"node --version"}}\n');
    await execFileAsync('git', ['-C', fixtureRoot, 'init', '-q']);
    await execFileAsync('git', ['-C', fixtureRoot, 'config', 'user.name', 'External Fixture']);
    await execFileAsync('git', ['-C', fixtureRoot, 'config', 'user.email', 'external@example.invalid']);
    await execFileAsync('git', ['-C', fixtureRoot, 'remote', 'add', 'origin', 'https://github.com/example/external.git']);
    await execFileAsync('git', ['-C', fixtureRoot, 'add', '.']);
    await execFileAsync('git', ['-C', fixtureRoot, 'commit', '-qm', 'fixture']);

    const {stdout, stderr} = await execFileAsync(process.execPath, [
      runnerPath,
      'https://github.com/example/external/issues/1',
      fixtureRoot,
      'yes',
      'yes',
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).catch((error) => ({
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      code: error.code,
    }));

    assert.equal(stderr, '');
    const result = JSON.parse(stdout);
    assert.equal(result.kind, 'run-error');
    assert.notEqual(result.code, undefined);
  } finally {
    await fs.rm(fixtureRoot, {recursive: true, force: true});
  }
});
