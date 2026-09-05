# prove-the-ticket

`prove-the-ticket` turns one public GitHub issue and one matching clean Node
checkout into a proof card. It reads the issue anonymously, asks the user to
confirm the existing acceptance criteria, asks for approval of an independent
verification command plan, and runs every command through the isolated
execution boundary from issue #2. The workflow does not write to GitHub.

## Public issue proof

```js
import {runIssueProof} from 'prove-the-ticket';

const result = await runIssueProof({
  issueUrl: 'https://github.com/owner/repository/issues/42',
  checkoutPath: '/work/repository',
  commands: [
    {executable: 'npm', args: ['run', 'check'], criteria: ['criterion-1']},
    {executable: 'npm', args: ['test'], criteria: ['criterion-2']},
  ],
}, {
  decisions: {
    confirmCriteria: async (criteria) => confirmCriteriaWithUser(criteria),
    approvePlan: async (plan) => approvePlanWithUser(plan),
  },
});
```

The operation accepts HTTPS issue URLs and matching HTTPS or SSH GitHub
remotes. It requires one or more checkboxes beneath an `Acceptance criteria`
heading and keeps each checkbox's source order, text, checked state, and
nesting in the result. The checked state is metadata, not evidence.

Use `commands` to provide one or more command entries. Each entry contains a
Node executable, argument list, and one or more stable criterion IDs. A
criterion may map to multiple commands. A command with no explicit mapping
maps to every extracted criterion. The older singular `command` input remains
supported and maps its command to every criterion.

The plan callback receives every command, mapping, and timeout together. It
must approve the complete plan. If the callback edits the presented plan or
returns `{approved: true, plan: revisedPlan}`, the operation hashes the revised
plan, marks it pending, and asks for approval again. It never executes an
edited plan without a second approval.

The checkout must be clean. The code fingerprint records the commit, an empty
tracked-patch hash, empty dirty and untracked lists, lockfile identity or
explicit absence, `COMPLETE`, and a digest. Environment details remain outside
that fingerprint.

The plan contains the exact commands and their criterion mappings. The default
timeout is 300 seconds. Callers may set a timeout from 1 through 3,600 seconds.
The boundary rejects dependency installation, denies network access, keeps the
checkout and dependencies read-only, and gives the command a separate scratch
directory through `PROVE_THE_TICKET_SCRATCH_DIR`.

## Results

A successful run returns versioned JSON with ticket identity, the proof
subject, approved evidence plan, execution environment, every command outcome,
per-criterion results, overall status, warnings, and a `sha256-v1:` proof seal.
A criterion is `PROVED` only when every mapped command exits zero. A nonzero
exit or signal makes a mapped criterion `FAILED`. A timeout, unavailable
dependency tree, policy failure, or missing mapping makes it `UNVERIFIED`.
The overall result is `FAILED` when any criterion fails. Otherwise it is
`INCOMPLETE` when any criterion is unverified.

Isolation, snapshot, source-freshness, and internal failures happen before a
trustworthy command result exists. Those errors return no overall status and no
proof seal.

The proof card and JSON replace the exact local checkout and temporary snapshot
paths with stable placeholders. Output excerpts are bounded and masked. They
do not contribute to the proof seal, so timestamps, durations, output text, and
formatting changes do not change the seal.

For a local Rote integration or a test, `createIssueProofPlay` provides the
same `run(input)` entry point with controlled GitHub, checkout, confirmation,
environment, and isolation adapters.

## Execution boundary

The lower-level boundary can also be used directly:

```js
import {executeProofCommand} from 'prove-the-ticket';

const result = await executeProofCommand({
  proofSubject,
  approvedCommand: command,
});
```

It reconstructs a fingerprinted committed tree in a temporary workspace,
checks the manifest, captures bounded stdout and stderr, and reports exit,
signal, timeout, source-integrity, network, and cleanup facts. The snapshot and
existing dependency tree are read-only. The command's working directory is
repository-relative and its arguments stay separate from the executable.

The execution-boundary design is documented in
[`docs/architecture/execution-boundary.md`](docs/architecture/execution-boundary.md).
The public workflow design is documented in
[`docs/architecture/public-issue-proof.md`](docs/architecture/public-issue-proof.md).

## Verification

Run these commands from the repository root:

```sh
npm run check
npm test
```

The tests cover the public success path, URL and remote validation, ordered
criteria and checked metadata, shared and unmapped command mappings, repeated
plan approval after edits, nonzero and signal outcomes, independent progress,
timeouts, missing dependencies, policy rejection, freshness changes, output
privacy, stable seals, and the real Bubblewrap path when the host provides the
required Linux capabilities.
