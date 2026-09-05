# prove-the-ticket

## What it does

`prove-the-ticket` checks a public GitHub issue against its matching local Node
checkout. It returns versioned JSON, a proof card, and a deterministic proof
seal.

## Why it exists

A passing command is not enough to prove a ticket. The issue, checkout, command
plan, and execution result must all refer to the same code state. The Play keeps
those facts together and refuses to publish a result when it cannot verify them.

## How it works

1. Reads the issue anonymously and keeps its existing acceptance criteria.
2. Confirms the criteria and previews non-ignored untracked paths before reading
   eligible file contents.
3. Matches the issue repository to one local Git remote.
4. Presents the independent verification commands and their criterion mappings
   for approval.
5. Rebuilds the clean or dirty proof subject in a temporary snapshot.
6. Runs each approved command inside the Linux isolation boundary.
7. Rechecks the issue, checkout, and dependencies before creating the result.

The workflow reads GitHub but does not write comments or change issues.

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
    confirmUntracked: async (previews) => confirmUntrackedWithUser(previews),
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

The checkout may contain staged or unstaged tracked changes and approved safe
untracked files. The code fingerprint records the commit, one binary full-index
patch hash, sorted dirty paths and statuses, safe-untracked path, size, and
content-hash records, lockfile identity or explicit absence, completeness, and a
digest. Secret-like, oversized, over-limit, or unapproved untracked paths are
never read. Each such path emits `FINGERPRINT_INCOMPLETE`, so a qualified run
cannot be `PROVED`. When non-ignored untracked paths exist, `confirmUntracked`
must approve the metadata-only preview before eligible contents are read.

The plan contains the exact commands and their criterion mappings. The default
timeout is 300 seconds. Callers may set a timeout from 1 through 3,600 seconds.
The boundary rejects dependency installation, including `yarn dlx`, before it
creates a process. It denies network access, keeps the reconstructed checkout
and dependency tree read-only, rejects unrelated absolute executable and
argument paths, and gives the command a separate scratch directory through
`PROVE_THE_TICKET_SCRATCH_DIR`.

## Results

A successful run returns versioned JSON with ticket identity, the proof
subject, approved evidence plan, execution environment, every command outcome,
per-criterion results, overall status, warnings, and a `sha256-v1:` proof seal.
A criterion is `PROVED` only when every mapped command exits zero. A nonzero
exit or signal makes a mapped criterion `FAILED`. A timeout, unavailable
dependency tree, policy failure, or missing mapping makes it `UNVERIFIED`.
The overall result is `FAILED` when any criterion fails. Otherwise it is
`INCOMPLETE` when any criterion is unverified or the code fingerprint is
incomplete.

Isolation, snapshot, source-freshness, and internal failures happen before a
trustworthy command result exists. Those errors return no overall status and no
proof seal.

The proof card and JSON replace the exact local checkout and temporary snapshot
paths with stable placeholders. Explicit environment values, credential-shaped
text, secret-like untracked files, and private paths are redacted before they
are returned. Output excerpts have fixed byte limits and are clipped at UTF-8
boundaries. They do not contribute to the proof seal, so timestamps, durations,
output text, and formatting changes do not change the seal.

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

The boundary never mounts the host checkout. It mounts only the runtime and
required system directories, then mounts the reconstructed snapshot and the
existing dependency tree at private sandbox paths. The dependency tree's digest
is checked before and after the run, including between commands in one proof
run.

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

The tests cover the public success path, dirty tracked reconstruction, binary
patches, safe-untracked preview, approval and limits, secret-path exclusions,
lockfile selection, ordered criteria and checked metadata, shared and unmapped
command mappings, repeated plan approval after edits, nonzero and signal
outcomes, independent progress, timeouts, missing dependencies, policy
rejection, freshness changes, output privacy, stable seals, RFC 8785 number and
serialization vectors, and the real Bubblewrap path when the host provides the
required Linux capabilities.
