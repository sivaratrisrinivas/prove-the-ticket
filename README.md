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

Version 0.1.2 is the current pinned Community Play
[`prove-ticket/prove-the-ticket@0.1.2`](https://play.modiqo.ai/prove-ticket/prove-the-ticket@0.1.2).
Earlier immutable releases `0.1.0` and `0.1.1` remain available.
It reads one public GitHub issue and checks the matching local Node checkout.
It returns a proof card and a stable proof seal.

The Play accepts:

- `issue_url`: a full public GitHub issue URL;
- `checkout_path`: an absolute path to the local checkout;
- `confirm_criteria=yes`: explicit human confirmation of the extracted criteria;
- `approve_plan=yes`: explicit human approval of the complete command plan.

Run the local package:

```sh
rote play run rote/prove-the-ticket/main.ts \
  issue_url=https://github.com/sivaratrisrinivas/prove-the-ticket/issues/6 \
  checkout_path="$PWD" \
  confirm_criteria=yes \
  approve_plan=yes
```

Run the published package:

```sh
rote play run https://play.modiqo.ai/prove-ticket/prove-the-ticket@0.1.2 \
  issue_url=https://github.com/sivaratrisrinivas/prove-the-ticket/issues/6 \
  checkout_path="$PWD" \
  confirm_criteria=yes \
  approve_plan=yes \
  --yes
```

Use `rote play inspect` before running the published package. Rote shows the
inputs, access, effects, and package digest before execution.

Version 0.1 supports ordinary-file Node checkouts on capability-validated Linux
only. The checkout must have a root `package.json` with at least one of
`check`, `test`, or `verify`. The Play discovers those scripts in that order
and runs each as `npm run <name>`. It reads public issues anonymously.
Verification commands have no external network and cannot install dependencies.
The Play performs no GitHub write. The public card also lists the features that
are not part of 0.1.

The published package embeds its own verifier. The checkout you pass is only
the repository under inspection. The shareable result contains the privacy-safe
proof only. It does not render the local checkout path, temporary snapshot
paths, credentials, or untracked file contents.

The 0.1.2 release identity is recorded after publication. Earlier release
history remains in
[issue #8](https://github.com/sivaratrisrinivas/prove-the-ticket/issues/8).

## Self-proof evidence

The original self-proof for issue #7 is retained in
[`evidence/issue-7`](evidence/issue-7). It records the proof of all 20
criteria from completed issue #6 at the earlier implementation commit.

The 0.1.1 Community release was verified from its release commit against this
repository. The 0.1.2 release packages the verifier inside the Play so the same
pinned URI can prove an unrelated public Node repository that has matching
checkbox criteria and root `check`, `test`, or `verify` scripts.

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
