# prove-the-ticket

`prove-the-ticket` checks a public GitHub issue against the matching local Node
checkout. It returns versioned JSON, a proof card, and a deterministic proof
seal.

## Why it exists

A passing test does not prove that the right issue and code were checked. This
Play binds the issue criteria, Git state, approved commands, and results to one
proof subject.

## How it works

1. Reads the public issue anonymously and keeps its existing checkbox criteria.
2. Confirms the criteria and previews non-ignored untracked paths.
3. Matches the issue repository to one canonical GitHub remote.
4. Shows the complete independent-command plan for approval.
5. Rebuilds the committed tree and approved changes in a temporary snapshot.
6. Runs each command in a Linux Bubblewrap boundary with no network access.
7. Rechecks the issue, source, Git state, and dependencies before sealing the
   result.

Version 0.1 only reads GitHub. It does not write comments or change issues.

## Safety limits

- Only ordinary-file Node checkouts on Linux hosts with working isolation are
  supported.
- Install commands and fetch-capable launchers are rejected.
- The checkout and dependency tree are mounted read-only.
- The Node runtime is mounted read-only. The boundary fails closed if that
  mount would overlap the checkout.
- Symlinks, special files, submodules, Git LFS paths, sparse checkouts, linked
  worktrees, unsafe paths, and unsupported filenames fail closed.
- Secret-like, oversized, or unapproved untracked files are not read.
- Shareable results exclude exact local paths, temporary paths, credentials, and
  untracked-file contents.

## Results

Each criterion is `PROVED`, `FAILED`, or `UNVERIFIED`. The overall result is
`PROVED`, `FAILED`, or `INCOMPLETE`.

A precondition, isolation, snapshot, freshness, or internal error returns no
overall status or proof seal. Cleanup failures remain visible and make an
otherwise successful run `INCOMPLETE`.

The proof seal covers stable proof facts. Timestamps, durations, output
excerpts, and formatting do not change it. Output is bounded and masked.
Binary output is represented by its size and hash.

## Public Community Play

The release package in [`rote/prove-the-ticket`](rote/prove-the-ticket) is the
public Rote Play wrapper for the 0.1 implementation. It accepts:

- `issue_url`: a full public GitHub issue URL;
- `checkout_path`: an absolute path to the local checkout;
- `confirm_criteria=yes`: explicit human confirmation of the extracted criteria;
- `approve_plan=yes`: explicit human approval of the complete command plan.

Run the local package with:

```sh
rote play run rote/prove-the-ticket/main.ts \
  issue_url=https://github.com/sivaratrisrinivas/prove-the-ticket/issues/6 \
  checkout_path="$PWD" \
  confirm_criteria=yes \
  approve_plan=yes
```

The public card discloses that 0.1 supports ordinary-file Node checkouts on
capability-validated Linux only, reads public issues anonymously, denies network
access to verification commands, forbids dependency installation, and performs
no GitHub write. It also names the unsupported post-0.1 capabilities rather
than implying they are available.

The wrapper imports the implementation from the supplied checkout, so the
pinned Play remains an inspectable runner for the exact local source being
verified. Its shareable output contains the privacy-safe proof result only;
the local checkout path and temporary snapshot paths are not rendered.

## Self-proof evidence

Issue #7 is complete. At commit
`d306af34ceb6391bbabf93bf05c9aa45950a624b`, the Play proved all 20 criteria
from completed issue #6.

The run used two approved commands, `npm run check` and `npm test`, through the
anonymous public GitHub adapter and the production Linux boundary. All 71 tests
passed with no skips. The retained JSON, proof card, source-integrity record,
and proof seal are in [`evidence/issue-7`](evidence/issue-7).

## Verification

Run from the repository root:

```sh
npm run check
npm test
```

The workflow design is documented in
[`docs/architecture/public-issue-proof.md`](docs/architecture/public-issue-proof.md).
The isolation design is documented in
[`docs/architecture/execution-boundary.md`](docs/architecture/execution-boundary.md).
