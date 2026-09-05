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
    'ordinary-file Node checkouts on capability-validated Linux only',
    'issue reads are anonymous and public-only',
    'verification commands have no external network',
    'cannot install dependencies',
    'version 0.1 performs no GitHub write',
    'does not claim criteria generation',
    'does not claim criteria rewriting',
    'does not claim command dependencies',
    'does not claim output extraction',
    'does not claim static evidence',
    'does not claim manual evidence',
    'does not claim comments',
    'does not claim private repositories',
    'does not claim non-Node repositories',
    'does not claim cross-run reuse',
    'does not claim macOS',
    'does not claim Windows',
  ]) {
    assert.match(play, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), phrase);
  }

  for (const parameter of ['issue_url', 'checkout_path', 'confirm_criteria', 'approve_plan']) {
    assert.match(play, new RegExp(`name: ${parameter}`));
  }
  assert.match(play, /@resource\{run-proof\.mjs\}/);
});

test('keeps the published runner dependent on the checked-out implementation', async () => {
  const runner = await fs.readFile(runnerPath, 'utf8');

  assert.match(runner, /runIssueProof/);
  assert.match(runner, /authenticated !== false/);
  assert.match(runner, /confirmCriteria/);
  assert.match(runner, /approvePlan/);
  assert.match(runner, /pathToFileURL/);
  assert.doesNotMatch(runner, /process\.stdout\.write\([^)]*checkoutPath/);
});
