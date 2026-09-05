import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {createIssueProofPlay, runIssueProof} from '../src/index.js';
import {hashCanonicalJson} from '../src/canonical-json.js';

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
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          async execute(context) {
            calls.execution.push(context);
            return {state: 'EXITED', exitCode: 0, signal: null, stdout: Buffer.from('pass\n'), stderr: Buffer.alloc(0)};
          },
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
    assert.equal(calls.execution[0].sourcePath, fixture.root);
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

test('emits the documented ordered compatibility contract without dependency or environment leakage', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions());

    assert.deepEqual(Object.keys(result.json), [
      'schemaVersion',
      'ticket',
      'proofSubject',
      'evidencePlan',
      'proofRun',
      'criterionResults',
      'overallStatus',
      'proofSeal',
      'rerunInputs',
      'warnings',
    ]);
    assert.deepEqual(Object.keys(result.ticket), ['tracker', 'url', 'owner', 'repository', 'number', 'title', 'criteria']);
    assert.deepEqual(Object.keys(result.ticket.criteria[0]), ['id', 'text', 'checked', 'nesting', 'raw']);
    assert.deepEqual(Object.keys(result.proofSubject), ['criteriaHash', 'codeFingerprint']);
    assert.deepEqual(Object.keys(result.proofSubject.codeFingerprint), [
      'commitSha',
      'trackedPatchSha256',
      'dirtyFiles',
      'untrackedFiles',
      'lockfile',
      'completeness',
      'digest',
    ]);
    assert.equal(Object.hasOwn(result.proofSubject.codeFingerprint, 'dependencyDigest'), false);
    const {digest, ...fingerprintFacts} = result.proofSubject.codeFingerprint;
    assert.equal(digest, hashCanonicalJson(fingerprintFacts));
    assert.deepEqual(Object.keys(result.evidencePlan), ['hash', 'approval', 'commands']);
    assert.deepEqual(Object.keys(result.evidencePlan.commands[0]), ['id', 'command', 'criteria']);
    assert.deepEqual(Object.keys(result.evidencePlan.commands[0].command), [
      'executable',
      'args',
      'cwd',
      'timeoutSeconds',
      'environmentPolicy',
    ]);
    assert.deepEqual(Object.keys(result.proofRun), [
      'executionEnvironment',
      'startedAt',
      'endedAt',
      'durationMs',
      'runError',
      'commands',
      'cleanup',
    ]);
    assert.deepEqual(Object.keys(result.proofRun.executionEnvironment), [
      'os',
      'architecture',
      'git',
      'runtime',
      'packageManager',
    ]);
    assert.deepEqual(Object.keys(result.proofRun.commands[0]), ['id', 'command', 'mapping', 'execution', 'output']);
    assert.deepEqual(Object.keys(result.proofRun.commands[0].execution), [
      'state',
      'exitCode',
      'signal',
      'startedAt',
      'endedAt',
      'durationMs',
      'networkPolicy',
    ]);
    assert.deepEqual(Object.keys(result.proofRun.commands[0].output), ['streams', 'warnings']);
    assert.deepEqual(Object.keys(result.proofRun.commands[0].output.streams.stdout), [
      'binary',
      'byteCount',
      'excerpt',
      'truncated',
    ]);
    assert.deepEqual(Object.keys(result.criterionResults[0]), [
      'id',
      'text',
      'checked',
      'status',
      'evidence',
      'rationale',
    ]);
    assert.deepEqual(Object.keys(result.rerunInputs), [
      'issueUrl',
      'repository',
      'checkoutPath',
      'criteriaHash',
      'codeFingerprintDigest',
      'evidencePlanHash',
    ]);
    assert.equal(result.proofRun.executionEnvironment.os.family, 'linux');
    assert.equal(result.schemaVersion, '1.0');
    assert.equal(result.ticket.tracker, 'github');
    assert.equal(result.proofSubject.codeFingerprint.completeness, 'COMPLETE');
    assert.equal(result.evidencePlan.approval, 'APPROVED');
    assert.equal(result.proofRun.commands[0].execution.state, 'EXITED');
    assert.equal(Number.isInteger(result.proofRun.commands[0].execution.exitCode), true);
    assert.equal(result.proofRun.commands[0].execution.signal, null);
    assert.equal(result.proofRun.commands[0].execution.networkPolicy, 'DENIED');
    assert.equal(result.criterionResults[0].status, 'PROVED');
    assert.equal(result.overallStatus, 'PROVED');
    assert.equal(result.proofRun.cleanup.state, 'CLEANED');
    assert.equal(result.proofRun.runError, null);
    assert.match(result.proofSeal, /^sha256-v1:[0-9a-f]{64}$/);
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

test('runs independent commands and aggregates their mapped criterion outcomes', async () => {
  const fixture = await createFixture();
  const calls = {criteria: [], plans: [], execution: []};
  const outcomes = [
    processOutcome(),
    {...processOutcome(), exitCode: 2},
    processOutcome(),
  ];
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1', 'criterion-2']},
        {executable: process.execPath, args: ['-e', 'process.exit(2)'], criteria: ['criterion-2']},
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-3']},
      ],
    }, successfulOptions({
      github: {readIssue: async () => ({title: 'Multiple criteria', body: '## Acceptance criteria\n- [x] First promise.\n  - [ ] Nested second promise.\n- [ ] Third promise.\n\n## Notes\n- [ ] Outside the section.\n'})},
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
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        async execute(context) {
          calls.execution.push(context);
          return outcomes[calls.execution.length - 1];
        },
      }},
    }));

    assert.equal(calls.criteria[0].length, 3);
    assert.deepEqual(calls.criteria[0].map(({text, nesting, checked}) => ({text, nesting, checked})), [
      {text: 'First promise.', nesting: 0, checked: true},
      {text: 'Nested second promise.', nesting: 2, checked: false},
      {text: 'Third promise.', nesting: 0, checked: false},
    ]);
    assert.equal(calls.plans.length, 1);
    assert.equal(calls.plans[0].approval, 'PENDING');
    assert.deepEqual(calls.plans[0].commands.map(({criteria}) => criteria), [
      ['criterion-1', 'criterion-2'],
      ['criterion-2'],
      ['criterion-3'],
    ]);
    const commandIds = calls.plans[0].commands.map(({id}) => id);
    assert.equal(new Set(commandIds).size, 2);
    assert.match(commandIds[0], /^command-[0-9a-f]{64}$/);
    assert.equal(commandIds[0], commandIds[2]);
    assert.equal(calls.execution.length, 3);
    assert.deepEqual(result.criterionResults.map(({id, status}) => ({id, status})), [
      {id: 'criterion-1', status: 'PROVED'},
      {id: 'criterion-2', status: 'FAILED'},
      {id: 'criterion-3', status: 'PROVED'},
    ]);
    assert.equal(result.proofRun.commands.length, 3);
    assert.equal(result.overallStatus, 'FAILED');
    assert.match(result.proofCard, /Criterion criterion-3: PROVED Third promise\./);
  } finally {
    await remove(fixture.root);
  }
});

test('requires full plan approval again when a presented plan is edited', async () => {
  const fixture = await createFixture();
  const plans = [];
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1']},
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-2']},
      ],
    }, successfulOptions({
      github: {readIssue: async () => ({title: 'Editable plan', body: '## Acceptance criteria\n- [ ] First.\n- [ ] Second.\n'})},
      decisions: {
        confirmCriteria: async () => true,
        async approvePlan(plan) {
          plans.push(plan);
          if (plans.length === 1) {
            plan.commands[0].command.timeoutSeconds = 7;
            plan.commands[1].criteria = ['criterion-1', 'criterion-2'];
          }
          return true;
        },
      },
    }));

    assert.equal(plans.length, 2);
    assert.equal(plans[0].commands[0].command.timeoutSeconds, 7);
    assert.deepEqual(plans[1].commands[1].criteria, ['criterion-1', 'criterion-2']);
    assert.equal(result.evidencePlan.commands[0].command.timeoutSeconds, 7);
    assert.deepEqual(result.evidencePlan.commands[1].criteria, ['criterion-1', 'criterion-2']);
    assert.equal(result.overallStatus, 'PROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('marks an unmapped criterion unverified while running mapped commands', async () => {
  const fixture = await createFixture();
  let executions = 0;
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [{executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1']}],
    }, successfulOptions({
      github: {readIssue: async () => ({title: 'Unmapped criterion', body: '## Acceptance criteria\n- [ ] Mapped.\n- [ ] Unmapped.\n'})},
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async () => {
          executions += 1;
          return processOutcome();
        },
      }},
    }));

    assert.equal(executions, 1);
    assert.equal(result.criterionResults[0].status, 'PROVED');
    assert.equal(result.criterionResults[1].status, 'UNVERIFIED');
    assert.deepEqual(result.criterionResults[1].evidence, []);
    assert.equal(result.overallStatus, 'INCOMPLETE');
  } finally {
    await remove(fixture.root);
  }
});

test('continues independent commands after a policy-blocked command', async () => {
  const fixture = await createFixture();
  const executions = [];
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [
        {executable: 'npm', args: ['install'], criteria: ['criterion-1']},
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-2']},
      ],
    }, successfulOptions({
      github: {readIssue: async () => ({title: 'Independent policy', body: '## Acceptance criteria\n- [ ] Policy command.\n- [ ] Local command.\n'})},
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        async execute(context) {
          executions.push(context.command);
          return processOutcome();
        },
      }},
    }));

    assert.equal(result.proofRun.commands.length, 2);
    assert.equal(executions.length, 1);
    assert.equal(result.criterionResults[0].status, 'UNVERIFIED');
    assert.equal(result.criterionResults[1].status, 'PROVED');
    assert.equal(result.overallStatus, 'INCOMPLETE');
  } finally {
    await remove(fixture.root);
  }
});

test('rejects command dependencies, output evidence, and unknown mappings', async () => {
  const fixture = await createFixture();
  try {
    const dependency = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [{executable: process.execPath, args: ['-e', 'process.exit(0)'], dependsOn: [], criteria: ['criterion-1']}],
    }, successfulOptions());
    assert.equal(dependency.code, 'COMMAND_NOT_APPROVED');

    const outputEvidence = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [{executable: process.execPath, args: ['-e', 'process.exit(0)'], evidence: 'stdout', criteria: ['criterion-1']}],
    }, successfulOptions());
    assert.equal(outputEvidence.code, 'COMMAND_NOT_APPROVED');

    const unknownMapping = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [{executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-99']}],
    }, successfulOptions());
    assert.equal(unknownMapping.code, 'PLAN_NOT_APPROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('rechecks the public criteria before sealing', async () => {
  const fixture = await createFixture();
  let issueReads = 0;
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      github: {readIssue: async () => {
        issueReads += 1;
        return issueReads === 1 ? issue() : {...issue(), body: '## Acceptance criteria\n- [ ] Changed after approval.\n'};
      }},
    }));

    assert.equal(issueReads, 2);
    assert.equal(result.code, 'CRITERIA_CHANGED');
    assert.equal(result.cleanup.state, 'CLEANED');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('preserves cleanup when freshness detects source mutation after execution', async () => {
  const fixture = await createFixture();
  let issueReads = 0;
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      github: {
        readIssue: async () => {
          issueReads += 1;
          if (issueReads === 2) await fs.writeFile(path.join(fixture.root, 'source.js'), 'changed after execution\n');
          return issue();
        },
      },
    }));

    assert.equal(issueReads, 2);
    assert.equal(result.code, 'SOURCE_CHANGED');
    assert.equal(result.sourceIntegrity, 'CHANGED');
    assert.equal(result.cleanup.state, 'CLEANED');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('preserves command identities when command order changes', async () => {
  const fixture = await createFixture();
  const firstCommand = {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1']};
  const secondCommand = {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-2']};
  try {
    const first = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [firstCommand, secondCommand],
    }, successfulOptions({github: {readIssue: async () => ({title: 'Order', body: '## Acceptance criteria\n- [ ] First.\n- [ ] Second.\n'})}}));
    const second = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [secondCommand, firstCommand],
    }, successfulOptions({github: {readIssue: async () => ({title: 'Order', body: '## Acceptance criteria\n- [ ] First.\n- [ ] Second.\n'})}}));

    assert.equal(first.evidencePlan.commands[0].id, second.evidencePlan.commands[1].id);
    assert.equal(first.evidencePlan.commands[1].id, second.evidencePlan.commands[0].id);
    assert.equal(first.evidencePlan.commands[0].id, first.evidencePlan.commands[1].id);

    const changedEnvironment = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {...firstCommand, environmentPolicy: {variables: {TEST_VALUE: 'changed'}}},
    }, successfulOptions());
    assert.notEqual(changedEnvironment.evidencePlan.commands[0].id, first.evidencePlan.commands[0].id);
  } finally {
    await remove(fixture.root);
  }
});

test('changes the criteria hash when source order changes', async () => {
  const fixture = await createFixture();
  try {
    const first = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({github: {
      readIssue: async () => ({title: 'Order', body: '## Acceptance criteria\n- [ ] First.\n- [ ] Second.\n'}),
    }}));
    const second = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({github: {
      readIssue: async () => ({title: 'Order', body: '## Acceptance criteria\n- [ ] Second.\n- [ ] First.\n'}),
    }}));

    assert.notEqual(first.proofSubject.criteriaHash, second.proofSubject.criteriaHash);
    assert.notEqual(first.proofSeal, second.proofSeal);
  } finally {
    await remove(fixture.root);
  }
});

test('does not duplicate criteria under a nested acceptance heading', async () => {
  const fixture = await createFixture();
  let confirmedCriteria;
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      github: {readIssue: async () => ({title: 'Nested headings', body: '## Acceptance criteria\n- [ ] Outer.\n### Acceptance criteria\n- [ ] Nested.\n\n## Notes\n- [ ] Outside.\n'})},
      decisions: {
        async confirmCriteria(criteria) {
          confirmedCriteria = criteria;
          return true;
        },
        approvePlan: async () => true,
      },
    }));

    assert.deepEqual(confirmedCriteria.map(({id, text}) => ({id, text})), [
      {id: 'criterion-1', text: 'Outer.'},
      {id: 'criterion-2', text: 'Nested.'},
    ]);
    assert.equal(result.criterionResults.length, 2);
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

    const unsafeNumber = await runIssueProof({issueUrl: 'https://github.com/owner/repository/issues/9007199254740992', checkoutPath: fixture.root});
    assert.equal(unsafeNumber.code, 'INVALID_ISSUE_URL');

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

test('rejects a remote whose fetch and push URLs disagree', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => issue()},
      checkout: {
        readRemotes: async () => [
          {name: 'origin', kind: 'fetch', url: 'https://github.com/owner/repository.git'},
          {name: 'origin', kind: 'push', url: 'https://github.com/other/repository.git'},
        ],
      },
    });
    assert.equal(result.code, 'REPOSITORY_MISMATCH');
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
      boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => { executions += 1; return processOutcome(); }}},
    });
    assert.equal(criteriaRejected.code, 'CRITERIA_NOT_CONFIRMED');

    const planRejected = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      github: {readIssue: async () => issue()},
      decisions: {confirmCriteria: async () => true, approvePlan: async () => false},
      boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => { executions += 1; return processOutcome(); }}},
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
    ['dependencies', null, 'UNVERIFIED', 'INCOMPLETE'],
    ['policy', null, 'UNVERIFIED', 'INCOMPLETE'],
  ];
  for (const [name, outcome, criterionStatus, overallStatus] of cases) {
    const fixture = await createFixture({dependencies: name === 'dependencies'});
    try {
      const input = {issueUrl: issueUrl(), checkoutPath: fixture.root};
      if (name === 'policy') input.command = {executable: 'npm', args: ['install']};
      const result = await runIssueProof(input, {
        ...successfulOptions(),
        boundaryOptions: {
          isolation: {
            check: async () => ({available: true}),
            execute: async () => outcome || processOutcome(),
          },
        },
      });
      assert.equal(result.kind, 'proof-run', `${name}: ${result.code || result.message}`);
      assert.equal(result.criterionResults[0].status, criterionStatus, name);
      assert.equal(result.overallStatus, overallStatus, name);
      assert.match(result.proofSeal, /^sha256-v1:/, name);
    } finally {
      await remove(fixture.root);
    }
  }
});

test('returns no status or seal for a pre-result execution error', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      ...successfulOptions(),
      boundaryOptions: {isolation: {check: async () => ({available: false, reason: 'Bubblewrap unavailable'}), execute: async () => processOutcome()}},
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
      boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => outcomeWithOutput(`${fixture.root} top-secret first\n`)}},
    });
    const second = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, {
      ...successfulOptions(),
      redactionValues: ['top-secret'],
      now: sequenceClock(5000, 9000),
      boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => outcomeWithOutput(`${fixture.root} top-secret second\n`)}},
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

test('changes the seal when any stable proof fact changes', async () => {
  const fixture = await createFixture();
  const run = (input = {}, overrides = {}) => runIssueProof({
    issueUrl: issueUrl(),
    checkoutPath: fixture.root,
    ...input,
  }, successfulOptions(overrides));
  try {
    const base = await run();
    const changedCriteria = await run({}, {
      github: {
        readIssue: async () => ({
          title: 'Issue',
          body: '## Acceptance criteria\n- [ ] A different promise.\n',
        }),
      },
    });
    const changedCommand = await run({
      command: {executable: process.execPath, args: ['-e', 'process.exit(0);']},
    });
    const changedEnvironment = await run({}, {
      environment: {
        ...environment(),
        runtime: {name: 'node', version: '22.0.1'},
      },
    });
    const changedExplicitEnvironment = await run({
      command: {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        environmentPolicy: {variables: {TOKEN: 'x'}},
      },
    });
    const changedOutcome = await run({}, {
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => ({state: 'EXITED', exitCode: 2, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)}),
        },
      },
    });
    const changedWarning = await run({}, {
      redactionValues: ['top-secret'],
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => outcomeWithOutput('top-secret\n'),
        },
      },
    });

    assert.notEqual(changedCriteria.proofSeal, base.proofSeal);
    assert.notEqual(changedCommand.proofSeal, base.proofSeal);
    assert.notEqual(changedEnvironment.proofSeal, base.proofSeal);
    assert.notEqual(changedExplicitEnvironment.proofSeal, base.proofSeal);
    assert.notEqual(changedOutcome.proofSeal, base.proofSeal);
    assert.notEqual(changedWarning.proofSeal, base.proofSeal);
    await fs.writeFile(path.join(fixture.root, 'source.js'), 'changed\n');
    const changedFingerprint = await run();
    assert.notEqual(changedFingerprint.proofSeal, base.proofSeal);
  } finally {
    await remove(fixture.root);
  }
});

test('composes output masking, truncation, binary output, and source freshness into the public seam', async () => {
  const fixture = await createFixture();
  try {
    const truncated = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => outcomeWithOutput(Buffer.concat([
            Buffer.alloc(32768, 'a'),
            Buffer.alloc(32768, 'b'),
            Buffer.from('tail'),
          ])),
        },
      },
    }));
    assert.equal(truncated.kind, 'proof-run');
    assert.equal(truncated.proofRun.commands[0].output.streams.stdout.truncated, true);
    assert.equal(truncated.proofRun.commands[0].output.streams.stdout.byteCount, 65540);
    assert.equal(truncated.warnings.some(({code, stream}) => code === 'OUTPUT_TRUNCATED' && stream === 'stdout'), true);
    assert.equal(Buffer.byteLength(truncated.proofRun.commands[0].output.streams.stdout.excerpt) <= 4096, true);

    const binary = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => outcomeWithOutput(Buffer.from([0, 1, 2, 3])),
        },
      },
    }));
    const binaryStream = binary.proofRun.commands[0].output.streams.stdout;
    assert.equal(binaryStream.binary, true);
    assert.equal(binaryStream.excerpt, null);
    assert.equal(binary.warnings.some(({code}) => code === 'BINARY_OUTPUT_OMITTED'), true);

    const masked = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      redactionValues: ['credential-fixture'],
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => outcomeWithOutput('credential-fixture\n'),
        },
      },
    }));
    assert.equal(JSON.stringify(masked).includes('credential-fixture'), false);
    assert.equal(masked.warnings.some(({code}) => code === 'VALUE_REDACTED'), true);

    const sourceChanged = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async (context) => {
            await fs.writeFile(path.join(context.sourcePath, 'source.js'), 'mutated\n');
            return processOutcome();
          },
        },
      },
    }));
    assert.equal(sourceChanged.kind, 'run-error');
    assert.equal(sourceChanged.code, 'SOURCE_CHANGED');
    assert.equal(sourceChanged.overallStatus, null);
    assert.equal(sourceChanged.proofSeal, null);
    assert.equal(sourceChanged.cleanup.state, 'CLEANED');
    assert.equal(JSON.stringify(sourceChanged).includes(fixture.root), false);
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

test('reconstructs staged, unstaged, added, and binary tracked changes', async () => {
  const fixture = await createFixture({binary: true});
  try {
    await fs.writeFile(path.join(fixture.root, 'source.js'), 'staged\n');
    await git(fixture.root, ['add', 'source.js']);
    await fs.writeFile(path.join(fixture.root, 'source.js'), 'unstaged\n');
    await fs.writeFile(path.join(fixture.root, 'src/blob.bin'), Buffer.from([0, 255, 4, 3]));
    await git(fixture.root, ['add', 'src/blob.bin']);
    await fs.writeFile(path.join(fixture.root, 'added.js'), 'added\n');
    await git(fixture.root, ['add', 'added.js']);

    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async (context) => {
          assert.equal(await fs.readFile(path.join(context.snapshotPath, 'source.js'), 'utf8'), 'unstaged\n');
          assert.equal(await fs.readFile(path.join(context.snapshotPath, 'added.js'), 'utf8'), 'added\n');
          assert.deepEqual(await fs.readFile(path.join(context.snapshotPath, 'src/blob.bin')), Buffer.from([0, 255, 4, 3]));
          return processOutcome();
        },
      }},
    }));

    assert.deepEqual(result.proofSubject.codeFingerprint.dirtyFiles, [
      {path: 'added.js', status: 'A '},
      {path: 'source.js', status: 'MM'},
      {path: 'src/blob.bin', status: 'M '},
    ]);
    assert.equal(result.overallStatus, 'PROVED');
    assert.equal(await fs.readFile(path.join(fixture.root, 'source.js'), 'utf8'), 'unstaged\n');
  } finally {
    await remove(fixture.root);
  }
});

test('previews untracked paths before reading safe content and marks exclusions incomplete', async () => {
  const fixture = await createFixture();
  const previews = [];
  const secretPaths = [
    '.env',
    '.env.local',
    '.npmrc',
    'certificate.PEM',
    'credentials',
    'credentials.json',
    'id_ed25519',
    'id_rsa',
    'nested/.env.local',
    'private.KEY',
    'store.P12',
    'store.PFX',
  ];
  try {
    await fs.writeFile(path.join(fixture.root, 'safe.txt'), 'safe-content\n');
    await fs.mkdir(path.join(fixture.root, 'nested'));
    for (const secretPath of secretPaths) {
      await fs.writeFile(path.join(fixture.root, secretPath), 'secret-content\n');
    }
    await fs.writeFile(path.join(fixture.root, 'large.bin'), Buffer.alloc(1024 * 1024 + 1, 'x'));

    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      decisions: {
        confirmCriteria: async () => true,
        confirmUntracked: async (paths) => {
          previews.push(paths);
          assert.equal(paths.some((entry) => Object.hasOwn(entry, 'content')), false);
          return true;
        },
        approvePlan: async () => true,
      },
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async () => outcomeWithOutput('safe-content\n'),
      }},
    }));

    assert.equal(previews.length, 1);
    assert.deepEqual(previews[0].map(({path: entryPath}) => entryPath), [...secretPaths, 'large.bin', 'safe.txt'].sort());
    assert.equal(result.proofSubject.codeFingerprint.completeness, 'INCOMPLETE');
    assert.equal(result.overallStatus, 'INCOMPLETE');
    const incompleteWarnings = result.warnings.filter(({code}) => code === 'FINGERPRINT_INCOMPLETE');
    assert.equal(incompleteWarnings.filter(({reason}) => reason === 'FILE_TOO_LARGE').length, 1);
    assert.equal(incompleteWarnings.filter(({reason}) => reason === 'SECRET_PATH').length, secretPaths.length);
    assert.equal(incompleteWarnings.every(({path: entryPath}) => !entryPath || !secretPaths.includes(entryPath)), true);
    assert.equal(JSON.stringify(result).includes('safe-content'), false);
    assert.equal(JSON.stringify(result).includes('secret-content'), false);
    for (const secretPath of secretPaths) assert.equal(JSON.stringify(result).includes(secretPath), false);
  } finally {
    await remove(fixture.root);
  }
});

test('runs a multi-criterion play with an approved safe untracked subject', async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(path.join(fixture.root, 'approved.txt'), 'approved-content\n');
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        criteria: ['criterion-1', 'criterion-2'],
      },
    }, successfulOptions({
      github: {
        readIssue: async () => ({
          title: 'Approved untracked subject',
          body: '## Acceptance criteria\n- [ ] First promise.\n- [ ] Second promise.\n',
        }),
      },
      decisions: {
        confirmCriteria: async () => true,
        confirmUntracked: async (previews) => {
          assert.deepEqual(previews.map(({path: entryPath}) => entryPath), ['approved.txt']);
          assert.equal(Object.hasOwn(previews[0], 'content'), false);
          return true;
        },
        approvePlan: async () => true,
      },
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async (context) => {
            assert.equal(await fs.readFile(path.join(context.snapshotPath, 'approved.txt'), 'utf8'), 'approved-content\n');
            return processOutcome();
          },
        },
      },
    }));

    assert.deepEqual(result.criterionResults.map(({status}) => status), ['PROVED', 'PROVED']);
    assert.equal(result.proofSubject.codeFingerprint.completeness, 'COMPLETE');
    assert.deepEqual(result.proofSubject.codeFingerprint.untrackedFiles.map(({path: entryPath}) => entryPath), ['approved.txt']);
    assert.equal(result.overallStatus, 'PROVED');
    assert.equal(JSON.stringify(result).includes('approved-content'), false);
  } finally {
    await remove(fixture.root);
  }
});

test('requires explicit approval when non-ignored untracked paths exist', async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(path.join(fixture.root, 'safe.txt'), 'safe-content\n');
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions());

    assert.equal(result.code, 'UNTRACKED_NOT_APPROVED');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('resolves a nested checkout path to the repository root before proof planning', async () => {
  const fixture = await createFixture();
  await fs.mkdir(path.join(fixture.root, 'nested'));
  let executionSourcePath;
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: path.join(fixture.root, 'nested'),
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async (context) => {
            executionSourcePath = context.sourcePath;
            return processOutcome();
          },
        },
      },
    }));

    assert.equal(result.kind, 'proof-run');
    assert.equal(executionSourcePath, fixture.root);
    assert.equal(result.overallStatus, 'PROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('rejects a bare repository before treating it as a working checkout', async () => {
  const source = await createFixture();
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-bare-'));
  try {
    await execFileAsync('git', ['clone', '--bare', source.root, bare], {encoding: 'utf8'});
    await execFileAsync('git', ['-C', bare, 'remote', 'set-url', 'origin', 'https://github.com/Owner/Repository.git'], {encoding: 'utf8'});
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: bare,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions());

    assert.equal(result.code, 'REPOSITORY_MISMATCH');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(source.root);
    await remove(bare);
  }
});

test('uses only the fixed 0.1 secret-path exclusions', async () => {
  const fixture = await createFixture();
  const allowedNearMatches = ['.envrc', '.yarnrc', 'id_dsa', 'secret.json', 'foo.token', 'certificate.p8'];
  try {
    for (const entryPath of allowedNearMatches) {
      await fs.writeFile(path.join(fixture.root, entryPath), 'safe-near-match\n');
    }

    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      decisions: {
        confirmCriteria: async () => true,
        confirmUntracked: async () => true,
        approvePlan: async () => true,
      },
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => processOutcome(),
        },
      },
    }));

    assert.equal(result.proofSubject.codeFingerprint.completeness, 'COMPLETE');
    assert.deepEqual(
      result.proofSubject.codeFingerprint.untrackedFiles.map(({path: entryPath}) => entryPath),
      allowedNearMatches.sort(),
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(result.overallStatus, 'PROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('stops before later commands after a pre-result run error', async () => {
  const fixture = await createFixture();
  let executions = 0;
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      commands: [
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1']},
        {executable: process.execPath, args: ['-e', 'process.exit(0)'], criteria: ['criterion-1']},
      ],
    }, successfulOptions({
      boundaryOptions: {
        isolation: {
          check: async () => ({available: true}),
          execute: async () => {
            executions += 1;
            throw new Error('execution adapter failed');
          },
        },
      },
    }));

    assert.equal(executions, 1);
    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'INTERNAL_EXECUTION_ERROR');
    assert.equal(result.overallStatus, null);
    assert.equal(result.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('qualifies a proof when temporary-workspace cleanup fails', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      boundaryOptions: {
        cleanup: async () => {
          throw new Error('cleanup failure');
        },
        isolation: {
          check: async () => ({available: true}),
          execute: async () => processOutcome(),
        },
      },
    }));

    assert.equal(result.kind, 'proof-run');
    assert.equal(result.proofRun.cleanup.state, 'FAILED');
    assert.equal(result.warnings.some(({code}) => code === 'CLEANUP_FAILED'), true);
    assert.equal(result.overallStatus, 'INCOMPLETE');
    assert.match(result.proofSeal, /^sha256-v1:/);
  } finally {
    await remove(fixture.root);
  }
});

test('enforces the aggregate safe-untracked limit without reading excluded content', async () => {
  const fixture = await createFixture();
  try {
    for (let index = 0; index < 11; index += 1) {
      await fs.writeFile(path.join(fixture.root, `safe-${index}.bin`), Buffer.alloc(1024 * 1024, index));
    }
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      decisions: {confirmCriteria: async () => true, confirmUntracked: async () => true, approvePlan: async () => true},
      boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => processOutcome()}},
    }));

    assert.equal(result.proofSubject.codeFingerprint.untrackedFiles.length, 10);
    assert.equal(result.proofSubject.codeFingerprint.completeness, 'INCOMPLETE');
    assert.deepEqual(result.warnings.filter(({reason}) => reason === 'AGGREGATE_LIMIT').map(({path: entryPath}) => entryPath), ['safe-9.bin']);
    assert.equal(result.overallStatus, 'INCOMPLETE');
  } finally {
    await remove(fixture.root);
  }
});

test('rejects unsupported untracked shapes before planning or execution', async (t) => {
  if (process.platform !== 'linux') t.skip('The special-file fixture requires Linux.');
  const fixture = await createFixture();
  let planned = false;
  try {
    await fs.symlink('source.js', path.join(fixture.root, 'link.js'));
    const symlinkResult = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      decisions: {confirmCriteria: async () => true, approvePlan: async () => { planned = true; return true; }},
    }));
    assert.equal(symlinkResult.code, 'UNSUPPORTED_CHECKOUT_SHAPE');
    assert.deepEqual(symlinkResult.details, {subtype: 'SYMLINK'});
    assert.equal(planned, false);
    assert.equal(symlinkResult.overallStatus, null);
    assert.equal(symlinkResult.proofSeal, null);

    await fs.rm(path.join(fixture.root, 'link.js'));
    await fs.rm(path.join(fixture.root, 'source.js'));
    await execFileAsync('mkfifo', [path.join(fixture.root, 'source.js')]);
    const specialResult = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      decisions: {confirmCriteria: async () => true, approvePlan: async () => { planned = true; return true; }},
    }));
    assert.equal(specialResult.code, 'UNSUPPORTED_CHECKOUT_SHAPE');
    assert.deepEqual(specialResult.details, {subtype: 'SPECIAL_FILE'});
    assert.equal(planned, false);
    assert.equal(specialResult.overallStatus, null);
    assert.equal(specialResult.proofSeal, null);
  } finally {
    await remove(fixture.root);
  }
});

test('fingerprints a changed selected lockfile', async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(path.join(fixture.root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await git(fixture.root, ['add', 'package-lock.json']);
    await git(fixture.root, ['commit', '-qm', 'add lockfile']);
    const lockfileBytes = Buffer.from('{"lockfileVersion":4}\n');
    await fs.writeFile(path.join(fixture.root, 'package-lock.json'), lockfileBytes);
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions());

    assert.deepEqual(result.proofSubject.codeFingerprint.lockfile, {
      path: 'package-lock.json',
      sha256: createHash('sha256').update(lockfileBytes).digest('hex'),
    });
    assert.equal(result.overallStatus, 'PROVED');
  } finally {
    await remove(fixture.root);
  }
});

test('supports tracked dirty checkouts and rejects competing lockfiles', async () => {
  const dirty = await createFixture();
  try {
    await fs.writeFile(path.join(dirty.root, 'source.js'), 'changed\n');
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: dirty.root}, successfulOptions({
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async (context) => {
          assert.equal(await fs.readFile(path.join(context.snapshotPath, 'source.js'), 'utf8'), 'changed\n');
          return processOutcome();
        },
      }},
    }));
    assert.equal(result.kind, 'proof-run');
    assert.deepEqual(result.proofSubject.codeFingerprint.dirtyFiles, [{path: 'source.js', status: ' M'}]);
    assert.notEqual(result.proofSubject.codeFingerprint.trackedPatchSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(result.overallStatus, 'PROVED');
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

test('binds the existing dependency tree to the complete proof run', async () => {
  const fixture = await createFixture();
  const dependencyPath = path.join(fixture.root, 'node_modules/package.json');
  try {
    await fs.writeFile(path.join(fixture.root, '.gitignore'), 'node_modules/\n');
    await git(fixture.root, ['add', '.gitignore']);
    await git(fixture.root, ['commit', '-qm', 'ignore dependencies']);
    await fs.mkdir(path.dirname(dependencyPath), {recursive: true});
    await fs.writeFile(dependencyPath, '{"name":"fixture-dependency"}\n');
    const result = await runIssueProof({issueUrl: issueUrl(), checkoutPath: fixture.root}, successfulOptions({
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async () => {
          await fs.writeFile(dependencyPath, '{"name":"mutated-dependency"}\n');
          return processOutcome();
        },
      }},
    }));
    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'SOURCE_CHANGED');
    assert.equal(result.sourceIntegrity, 'CHANGED');
    assert.equal(result.cleanup.state, 'CLEANED');
  } finally {
    await remove(fixture.root);
  }
});

test('preserves cleanup for a dependency policy error after fingerprinting', async () => {
  const fixture = await createFixture({dependencies: true});
  const dependencyPath = path.join(fixture.root, 'node_modules/missing-package/index.js');
  let executions = 0;
  let cleanups = 0;
  try {
    await fs.writeFile(path.join(fixture.root, '.gitignore'), 'node_modules/\n');
    await git(fixture.root, ['add', '.gitignore']);
    await git(fixture.root, ['commit', '-qm', 'ignore dependencies']);
    await fs.mkdir(path.dirname(dependencyPath), {recursive: true});
    await fs.writeFile(dependencyPath, 'module.exports = true;\n');
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)']},
    }, successfulOptions({
      boundaryOptions: {
        cleanup: async (rootPath) => {
          cleanups += 1;
          await fs.rm(rootPath, {recursive: true, force: true});
          throw new Error('cleanup failure');
        },
        isolation: {
          check: async () => {
            await fs.rm(path.dirname(dependencyPath), {recursive: true, force: true});
            return {available: true};
          },
          execute: async () => {
            executions += 1;
            return processOutcome();
          },
        },
      },
    }));

    assert.equal(result.kind, 'proof-run');
    assert.equal(executions, 0);
    assert.equal(cleanups, 1);
    assert.equal(result.criterionResults[0].status, 'UNVERIFIED');
    assert.equal(result.overallStatus, 'INCOMPLETE');
    assert.equal(result.proofRun.cleanup.state, 'FAILED');
    assert.equal(result.warnings.some(({code}) => code === 'CLEANUP_FAILED'), true);
  } finally {
    await remove(fixture.root);
  }
});

test('redacts short explicit command environment values in the public artifact', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)'], environmentPolicy: {variables: {TOKEN: 'x'}}},
    }, successfulOptions({
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async () => outcomeWithOutput('x\n'),
      }},
    }));
    assert.equal(JSON.stringify(result).includes('x\n'), false);
    assert.match(JSON.stringify(result), /<redacted>/);
  } finally {
    await remove(fixture.root);
  }
});

test('redacts short explicit values from public execution errors', async () => {
  const fixture = await createFixture();
  try {
    const result = await runIssueProof({
      issueUrl: issueUrl(),
      checkoutPath: fixture.root,
      command: {executable: process.execPath, args: ['-e', 'process.exit(0)'], environmentPolicy: {variables: {TOKEN: 'x'}}},
    }, successfulOptions({
      boundaryOptions: {isolation: {
        check: async () => ({available: true}),
        execute: async () => { throw new Error('x'); },
      }},
    }));
    assert.equal(result.code, 'INTERNAL_EXECUTION_ERROR');
    assert.equal(result.message, '<redacted>');
  } finally {
    await remove(fixture.root);
  }
});

function successfulOptions(overrides = {}) {
  return {
    github: {readIssue: async () => issue()},
    decisions: {confirmCriteria: async () => true, approvePlan: async () => true},
    boundaryOptions: {isolation: {check: async () => ({available: true}), execute: async () => processOutcome()}},
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

function processOutcome() {
  return {state: 'EXITED', exitCode: 0, signal: null, stdout: Buffer.from('pass\n'), stderr: Buffer.alloc(0)};
}

function outcomeWithOutput(output) {
  return {...processOutcome(), stdout: Buffer.from(output)};
}

async function createFixture({remote = 'https://github.com/Owner/Repository.git', dependencies = false, binary = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-issue-proof-'));
  const packageJson = dependencies
    ? '{"name":"fixture","scripts":{"test":"node --version"},"dependencies":{"missing-package":"1.0.0"}}\n'
    : '{"name":"fixture","scripts":{"test":"node --version"}}\n';
  await fs.writeFile(path.join(root, 'package.json'), packageJson);
  await fs.writeFile(path.join(root, 'source.js'), 'export const value = 1;\n');
  if (binary) {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0, 1, 2, 3]));
  }
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
