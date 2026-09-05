import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const playPath = path.join(root, 'rote', 'prove-the-ticket', 'main.ts');
const runnerPath = path.join(root, 'rote', 'prove-the-ticket', 'resources', 'run-proof.mjs');
const verifierDir = path.join(root, 'rote', 'prove-the-ticket', 'resources', 'verifier');
const sourceDir = path.join(root, 'src');
const VERIFIER_FILES = [
  'index.js',
  'canonical-json.js',
  'command-policy.js',
  'execution-boundary.js',
  'issue-proof.js',
];

test('declares the public 0.1 Rote contract and required confirmations', async () => {
  const play = await fs.readFile(playPath, 'utf8');

  for (const phrase of [
    'ordinary-file Node checkouts on Linux after the required isolation checks pass',
    'reads public issues anonymously',
    'Verification commands have no network access',
    'cannot install dependencies',
    'Version 0.1 never writes to GitHub',
    'does not generate or rewrite criteria',
    'manage command dependencies',
    'extract output',
    'collect static or manual evidence',
    'post comments',
    'use private or non-Node repositories',
    'reuse results across runs',
    'support macOS',
    'support macOS or Windows',
  ]) {
    assert.match(play, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), phrase);
  }

  for (const parameter of ['issue_url', 'checkout_path', 'confirm_criteria', 'approve_plan']) {
    assert.match(play, new RegExp(`name: ${parameter}`));
  }
  assert.match(play, /@resource\{run-proof\.mjs\}/);
  assert.match(play, /version: 0\.1\.2/);
});

test('packages an independent verifier runtime that matches the source tree', async () => {
  const runner = await fs.readFile(runnerPath, 'utf8');

  assert.match(runner, /runIssueProof/);
  assert.match(runner, /authenticated !== false/);
  assert.match(runner, /confirmCriteria/);
  assert.match(runner, /approvePlan/);
  assert.match(runner, /pathToFileURL/);
  assert.match(runner, /verifier['"]?, ['"]index\.js['"]/);
  assert.doesNotMatch(runner, /path\.join\(checkoutPath,\s*['"]src['"]/);
  assert.doesNotMatch(runner, /The checkout does not contain the prove-the-ticket implementation/);
  assert.doesNotMatch(runner, /process\.stdout\.write\([^)]*checkoutPath/);

  for (const name of VERIFIER_FILES) {
    const packaged = await fs.readFile(path.join(verifierDir, name));
    const source = await fs.readFile(path.join(sourceDir, name));
    assert.deepEqual(packaged, source, `${name} must match src/${name}`);
  }
});

test('loads the packaged verifier without needing the target checkout implementation', async () => {
  const {runIssueProof} = await import(pathToFileURL(path.join(verifierDir, 'index.js')).href);
  assert.equal(typeof runIssueProof, 'function');
});

test('runs the packaged runner against a Node checkout that has no src/index.js', async () => {
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

    assert.equal(stderr.includes('The checkout does not contain the prove-the-ticket implementation.'), false);
    assert.equal(stderr.includes('The packaged prove-the-ticket verifier could not be loaded.'), false);
    const result = JSON.parse(stdout);
    assert.equal(result.kind, 'run-error');
    assert.notEqual(result.code, undefined);
  } finally {
    await fs.rm(fixtureRoot, {recursive: true, force: true});
  }
});
