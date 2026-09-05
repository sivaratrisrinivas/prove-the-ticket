# prove-the-ticket

## What it does

`prove-the-ticket` checks a public GitHub issue against the matching local
checkout. It returns versioned JSON, a proof card, and a deterministic proof
seal.

## Why it exists

A passing command does not prove that the right ticket and code were checked.
This Play binds the issue criteria, local Git state, approved commands, and
results to one proof subject.

## How it works

1. Read a public issue anonymously and extract its checkbox criteria.
2. Confirm the criteria and preview non-ignored untracked paths before reading
   eligible files.
3. Resolve the supplied path to a non-bare Git repository and match its GitHub
   remote to the issue.
4. Show the exact independent commands, mappings, and timeouts for approval.
5. Rebuild the committed tree, tracked changes, and approved untracked files in
   a temporary snapshot.
6. Run commands in a Linux isolation boundary with no external network,
   read-only source and dependencies, and a separate scratch directory.
7. Recheck the issue, source, Git state, and dependencies before sealing the
   result.

The Play reads GitHub. Version 0.1 does not write comments or change issues.

## Example

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

The issue URL must identify a public GitHub issue. The issue must contain
checkboxes below an `Acceptance criteria` heading. Checked boxes remain source
metadata and never count as evidence.

Commands use exact executable and argument boundaries. A command maps to every
criterion by default, or to the criterion IDs supplied in `criteria`. The
default timeout is 300 seconds. Approved timeouts range from 1 to 3,600
seconds. Any plan edit requires approval again.

## Safety limits

- Version 0.1 supports ordinary-file Node checkouts on Linux hosts that pass
  the isolation capability check.
- Dependency installation commands and fetch-capable launchers are rejected.
- The source checkout and existing dependency tree are never mounted writable.
- Network access is denied inside the command boundary.
- Symlinks, special files, submodules, Git LFS paths, sparse checkouts, linked
  worktrees, unsafe paths, and unsupported filenames fail closed.
- Secret-like, oversized, or unapproved untracked files are not read. Excluded
  paths make the fingerprint incomplete.
- Exact checkout paths, temporary paths, credentials, and untracked contents
  are excluded from shareable results.

## Results

Each criterion is `PROVED`, `FAILED`, or `UNVERIFIED`.

- `PROVED` means every mapped command exited zero.
- `FAILED` means a mapped command exited nonzero or was terminated by a signal.
- `UNVERIFIED` means evidence was missing or a command had no trustworthy
  outcome.

The overall result is `PROVED`, `FAILED`, or `INCOMPLETE`. A precondition,
isolation, snapshot, freshness, or internal error has no overall status or
proof seal. A cleanup failure remains visible and qualifies an otherwise
successful run as `INCOMPLETE`.

The proof seal covers stable proof facts, not timestamps, durations, output
excerpts, or presentation formatting. Output is bounded, masked, and clipped
at UTF-8 boundaries. Binary output is represented by its size and hash.

## Execution boundary

The lower-level boundary can be used directly:

```js
import {executeProofCommand} from 'prove-the-ticket';

const result = await executeProofCommand({
  proofSubject,
  approvedCommand: command,
});
```

It reconstructs the proof subject, verifies the manifest, runs one command, and
reports exit, signal, timeout, source-integrity, network, and cleanup facts.
The design is documented in
[`docs/architecture/execution-boundary.md`](docs/architecture/execution-boundary.md).
The public workflow is documented in
[`docs/architecture/public-issue-proof.md`](docs/architecture/public-issue-proof.md).

## Verification

Run from the repository root:

```sh
npm run check
npm test
```

The 0.1 code path is implemented and tested. A real self-proof demonstration
and immutable Community publication are tracked separately in issues #7 and #8.
