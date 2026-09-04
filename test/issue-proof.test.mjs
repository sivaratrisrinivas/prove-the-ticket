import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {createIssueProofPlay, runIssueProof} from '../src/index.js';

const execFileAsync = promisify(execFile);

test('runs one confirmed public issue through a clean checkout to a proof card', async () => {
  const fixture = await createFixture();
  const calls = {issue: [], criteria: [], plans: [], execution: []};
  try {
    const result = await runIssueProof({
      issueUrl: 'https://github.com/OWNER/REPOSITORY/issues/3',
      checkoutPath: fixture.root,
    }, {
      github: {
        async readIssue(request) {
          calls.issue.push(request);
          return {number: 3, title: 'Public issue', body: '## Acceptance criteria\n- [x] The proof is truthful.\n\n## Notes\n- [ ] This is outside the section.\n'};
        },
      },
      decisions: {
        async confirmCriteria(criteria) {
          calls.criteria.push(criteria);
          return true;
        },
        async approvePlan(plan) {
          calls.plans.push(plan);
          return true;
        },
      },
      execution: {
        async execute(request) {
          calls.execution.push(request);
          return {
            kind: 'command-outcome',
            execution: {
              state: 'EXITED',
              exitCode: 0,
              signal: null,
              startedAt: '2026-09-05T00:00:00.000Z',
              endedAt: '2026-09-05T00:00:00.010Z',
              durationMs: 10,
              networkPolicy: 'DENIED',
            },
            output: {
              streams: {
                stdout: {binary: false, byteCount: 5, excerpt: 'pass\n', truncated: false},
                stderr: {binary: false, byteCount: 0, excerpt: '', truncated: false},
              },
            },
            warnings: [],
            cleanup: {state: 'CLEANED'},
          };
        },
      },
      environment: environment(),
      now: sequenceClock(),
    });

    assert.equal(calls.issue[0].authenticated, false);
    assert.deepEqual(calls.issue[0], {owner: 'owner', repository: 'repository', number: 3, authenticated: false});
    assert.equal(calls.criteria[0][0].text, 'The proof is truthful.');
    assert.equal(calls.criteria[0][0].checked, true);
    assert.equal(calls.plans[0].approval, 'PENDING');
    assert.equal(calls.plans[0].commands[0].command.executable, 'npm');
    assert.deepEqual(calls.plans[0].commands[0].command.args, ['run', 'test']);
    assert.equal(calls.execution.length, 1);
    assert.equal(calls.execution[0].proofSubject.sourcePath, fixture.root);
    assert.equal(result.kind, 'proof-run');
    assert.equal(result.ticket.url, 'https://github.com/owner/repository/issues/3');
    assert.equal(result.ticket.criteria[0].checked, true);
    assert.equal(result.proofSubject.codeFingerprint.completeness, 'COMPLETE');
    assert.deepEqual(result.proofSubject.codeFingerprint.dirtyFiles, []);
    assert.deepEqual(result.proofSubject.codeFingerprint.untrackedFiles, []);
    assert.deepEqual(result.proofSubject.codeFingerprint.lockfile, {path: null, sha256: null});
    assert.equal(result.evidencePlan.approval, 'APPROVED');
    assert.equal(result.criterionResults[0].status, 'PROVED');
    assert.equal(result.overallStatus, 'PROVED');
    assert.match(result.proofSeal, /^sha256-v1:[0-9a-f]{64}$/);
    assert.equal(result.json.proofSeal, result.proofSeal);
    assert.match(result.proofCard, /Overall: PROVED/);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
    assert.equal(JSON.stringify(result).includes('writeIssue'), false);
  } finally {
    await remove(fixture.root);
  }
});

test('normalizes SSH remotes and preserves original unchecked criterion metadata', async () => {
  const fixture = await createFixture({remote: 'git@github.com:Owner/Repository.git'});
  try {
    const result = await runIssueProof({
      issueUrl: 'https://github.com/owner/repository/issues/9',
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutSeconds: 7},
    }, successfulOptions({github: {readIssue: async () => ({...issue(), body: '### Acceptance criteria\n  - [ ] Keep the source wording.\n'})}}));

    assert.equal(result.ticket.criteria[0].checked, false);
    assert.equal(result.ticket.criteria[0].text, 'Keep the source wording.');
    assert.equal(result.evidencePlan.commands[0].command.timeoutSeconds, 7);
    assert.equal(result.overallStatus, 'PROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('rejects invalid URLs, pull requests, unavailable issues, mismatched remotes, and missing criteria', async () => {
  const fixture = await createFixture();
  try {
    const invalid = await runIssueProof({issueUrl: 'not-a-url', checkoutPath: fixture.root});
    assert.equal(invalid.code, 'INVALID_ISSUE_URL');

    const pullRequest = await runIssueProof({issueUrl: 'https://github.com/owner/repository/pull/3', checkoutPath: fixture.root});
    assert.equal(pullRequest.code, 'INVALID_ISSUE_URL');

    const unavailable = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => null},
    });
    assert.equal(unavailable.code, 'PUBLIC_ISSUE_UNAVAILABLE');

    const mismatch = await runIssueProof({issueUrl: 'https://github.com/other/repo/issues/3', checkoutPath: fixture.root}, {
      github: {readIssue: async () => issue()},
    });
    assert.equal(mismatch.code, 'REPOSITORY_MISMATCH');

    const noCriteria = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => ({title: 'No criteria', body: '# Notes\n- [ ] no\n'})},
    });
    assert.equal(noCriteria.code, 'EXPLICIT_CRITERIA_REQUIRED');
  } finally {
    await remove(fixture.root);
  }
});

test('requires both explicit human confirmations before execution', async () => {
  const fixture = await createFixture();
  let executions = 0;
  try {
    const criteriaRejected = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => issue()},
      decisions: {confirmCriteria: async () => false, approvePlan: async () => true},
      execution: {execute: async () => { executions += 1; return successfulOutcome(); }},
    });
    assert.equal(criteriaRejected.code, 'CRITERIA_NOT_CONFIRMED');

    const planRejected = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => issue()},
      decisions: {confirmCriteria: async () => true, approvePlan: async () => false},
      execution: {execute: async () => { executions += 1; return successfulOutcome(); }},
    });
    assert.equal(planRejected.code, 'PLAN_NOT_APPROVED');
    assert.equal(executions, 0);
  } finally {
    await remove(fixture.root);
  }
});

test('maps command, timeout, dependency, and policy outcomes to criterion and overall states', async () => {
  const cases = [
    ['nonzero', {state: 'EXITED', exitCode: 2, signal: null}, 'FAILED', 'FAILED'],
    ['signal', {state: 'SIGNALED', exitCode: null, signal: 'SIGTERM'}, 'FAILED', 'FAILED'],
    ['timeout', {state: 'TIMED_OUT', exitCode: null, signal: 'SIGKILL'}, 'UNVERIFIED', 'INCOMPLETE'],
    ['dependencies', {kind: 'run-error', code: 'DEPENDENCIES_UNAVAILABLE', message: 'missing'}, 'UNVERIFIED', 'INCOMPLETE'],
    ['policy', {kind: 'run-error', code: 'INSTALL_COMMAND_REJECTED', message: 'blocked'}, 'UNVERIFIED', 'INCOMPLETE'],
  ];
  const fixture = await createFixture();
  try {
    for (const [name, outcome, criterionStatus, overallStatus] of cases) {
      const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
        ...successfulOptions(),
        execution: {execute: async () => ({kind: outcome.kind || 'command-outcome', ...(outcome.kind ? {code: outcome.code, message: outcome.message} : {execution: {...outcome}, warnings: [], cleanup: {state: 'CLEANED'}})})},
      });
      assert.equal(result.kind, 'proof-run', `${name}: ${result.code || result.message}`);
      assert.equal(result.criterionResults[0].status, criterionStatus, name);
      assert.equal(result.overallStatus, overallStatus, name);
      assert.match(result.proofSeal, /^sha256-v1:/, name);
    }
  } finally {
    await remove(fixture.root);
  }
});

test('returns no status or seal for a pre-result execution error', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      ...successfulOptions(),
      execution: {execute: async () => ({kind: 'run-error', code: 'ISOLATION_UNAVAILABLE', message: 'Bubblewrap unavailable'})},
    });
    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'ISOLATION_UNAVAILABLE');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('runs through the default isolated boundary when Linux capabilities are available', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux is required.');
  const fixture = await createFixture();
  try {
    const play = createIssueProofPlay({
      github: {readIssue: async () => issue()},
      decisions: {confirmCriteria: async () => true, approvePlan: async () => true},
      environment: environment(),
      now: sequenceClock(),
    });
    const result = await play.run({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.stdout.write("pass\\n")'], timeoutSeconds: 2},
    });
    if (result.code === 'ISOLATION_UNAVAILABLE') return t.skip('The host cannot establish Bubblewrap namespaces.');
    assert.equal(result.kind, 'proof-run');
    assert.equal(result.criterionResults[0].status, 'PROVED');
    assert.equal(result.overallStatus, 'PROVED');
    assert.equal(result.proofRun.commands[0].execution.networkPolicy, 'DENIED');
  } finally {
    await remove(fixture.root);
  }
});

test('keeps seals stable across presentation changes and excludes private output', async () => {
  const fixture = await createFixture();
  try {
    const first = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      ...successfulOptions(),
      redactionValues: ['top-secret'],
      now: sequenceClock(1000, 2000),
      execution: {execute: async () => outcomeWithOutput(`${fixture.root} top-secret first\n`)},
    });
    const second = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      ...successfulOptions(),
      redactionValues: ['top-secret'],
      now: sequenceClock(5000, 9000),
      execution: {execute: async () => outcomeWithOutput(`${fixture.root} top-secret second\n`)},
    });

    assert.equal(first.proofSeal, second.proofSeal);
    assert.equal(first.proofRun.startedAt === second.proofRun.startedAt, false);
    assert.equal(JSON.stringify(first).includes(fixture.root), false);
    assert.equal(JSON.stringify(first).includes('top-secret'), false);
    assert.match(JSON.stringify(first), /<redacted>/);
    assert.match(first.proofCard, /<local-checkout>/);
  } finally {
    await remove(fixture.root);
  }
});

test('keeps the criteria hash independent from checked state and presentation whitespace', async () => {
  const fixture = await createFixture();
  try {
    const first = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({github: {
      readIssue: async () => ({title: 'Issue', body: '## Acceptance criteria\n- [ ] Keep   this wording.\n'}),
    }}));
    const second = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({github: {
      readIssue: async () => ({title: 'Issue', body: '## Acceptance criteria\n- [x] Keep this wording.\n'}),
    }}));
    assert.equal(first.proofSubject.criteriaHash, second.proofSubject.criteriaHash);
    assert.equal(first.proofSeal, second.proofSeal);
  } finally {
    await remove(fixture.root);
  }
});

test('requires a clean checkout and rejects competing lockfiles', async () => {
  const dirty = await createFixture();
  try {
    await fs.writeFile(path.join(dirty.root, 'source.js'), 'changed\n');
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: dirty.root}, successfulOptions());
    assert.equal(result.code, 'CLEAN_CHECKOUT_REQUIRED');
  } finally {
    await remove(dirty.root);
  }

  const lockfiles = await createFixture();
  try {
    await fs.writeFile(path.join(lockfiles.root, 'package-lock.json'), '{}\n');
    await fs.writeFile(path.join(lockfiles.root, 'yarn.lock'), '# lock\n');
    await git(lockfiles.root, ['add', '.']);
    await git(lockfiles.root, ['commit', '-qm', 'add lockfiles']);
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: lockfiles.root}, successfulOptions());
    assert.equal(result.code, 'LOCKFILE_SELECTION_REQUIRED');
  } finally {
    await remove(lockfiles.root);
  }
});

function successfulOptions(overrides = {}) {
  return {
    github: {readIssue: async () => issue()},
    decisions: {confirmCriteria: async () => true, approvePlan: async () => true},
    execution: {execute: async () => successfulOutcome()},
    environment: environment(),
    now: sequenceClock(),
    ...overrides,
  };
}

function issue() {
  return {number: 3, title: 'Issue', body: '## Acceptance criteria\n- [ ] The check passes.\n'};
}

function issueUrl() {
  return 'https://github.com/owner/repository/issues/3';
}

function environment() {
  return {
    os: {family: 'linux', version: '6.1'},
    architecture: 'x64',
    git: {name: 'git', version: '2.45.0'},
    runtime: {name: 'node', version: '22.0.0'},
    packageManager: {name: 'npm', version: '10.0.0'},
  };
}

function sequenceClock(start = 1000, end = 1010) {
  const values = [start, end];
  return () => values.shift() ?? end;
}

function successfulOutcome() {
  return {
    kind: 'command-outcome',
    execution: {state: 'EXITED', exitCode: 0, signal: null, networkPolicy: 'DENIED'},
    output: {streams: {stdout: {excerpt: 'pass\n'}, stderr: {excerpt: ''}}},
    warnings: [],
    cleanup: {state: 'CLEANED'},
  };
}

function outcomeWithOutput(output) {
  return {
    ...successfulOutcome(),
    output: {streams: {stdout: {binary: false, byteCount: output.length, excerpt: output, truncated: false}, stderr: {excerpt: ''}}},
  };
}

async function createFixture({remote = 'https://github.com/Owner/Repository.git'} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-issue-proof-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture","scripts":{"test":"node --version"}}\n');
  await fs.writeFile(path.join(root, 'source.js'), 'export const value = 1;\n');
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Proof Fixture']);
  await git(root, ['config', 'user.email', 'proof@example.invalid']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'fixture']);
  return {root};
}

async function git(root, args) {
  await execFileAsync('git', ['-C', root, ...args], {encoding: 'utf8'});
}

async function remove(root) {
  await fs.rm(root, {recursive: true, force: true});
}
