# Public issue proof

Issue #3 adds one public operation, `runIssueProof`, around the execution
boundary from issue #2. The caller supplies a full GitHub issue URL and a local
checkout, then supplies or accepts one existing Node verification command.
Injected GitHub, decision, checkout, and environment adapters keep the complete
path deterministic in tests. Boundary options can inject the existing
execution-boundary isolation adapter without allowing callers to replace the
boundary itself.

## Caller usage

```js
const result = await runIssueProof({
  issueUrl: 'https://github.com/owner/repository/issues/42',
  checkoutPath: '/work/repository',
  command: {executable: 'npm', args: ['test']},
}, {
  github: {readIssue},
  decisions: {confirmCriteria, approvePlan},
});
```

The caller receives a versioned JSON result, a restrained proof card, and a
deterministic proof seal for a trustworthy run. A rejected confirmation or a
pre-result safety failure returns a typed run error without an overall status or
seal.

## Shape

The operation owns the lifecycle in this order: parse and anonymously read the
public issue, normalize and match the checkout remote, extract one existing
criterion, confirm it, fingerprint the clean checkout, build and approve one
independent command plan, execute through the issue #2 boundary, classify the
command outcome, and assemble the public artifacts.

The domain is represented by a proof subject containing the criteria hash and a
repository-only code fingerprint. The executor receives a separate private
subject containing the absolute checkout path, manifest, patch bytes, and
dependency location. This separation keeps local operational state out of
shareable JSON. Run errors and command outcomes remain distinct result variants,
so a command failure can be reported as `FAILED` while a snapshot or isolation
failure has no status or seal.

Criteria, fingerprints, plans, and seal facts use canonical JSON before hashing.
The seal projection includes only stable proof facts. Output excerpts,
timestamps, durations, run IDs, formatting, and filesystem paths stay outside
the seal. Rendering sanitizes checkout and temporary paths and never includes
untracked content.

## Synthesis decision

The how walkthrough identified the existing execution boundary as the only
trusted command-running capability. Competing designs were considered against
that boundary, and the chosen deep-operation shape follows the grounded design
directly.

The lifecycle/session alternative would make transitions explicit, but it would
expose temporal coordination and duplicate invariants already owned by the
executor. The single operation hides that coordination while keeping the public
data shape explicit and testable. The public operation always constructs the
issue #2 execution boundary; test seams replace only its isolation adapter.

## Tradeoffs accepted

- The outer module contains several private helpers because these decisions must
  agree about one proof subject and one run lifecycle.
- The default GitHub adapter performs only an anonymous read; private access and
  every GitHub write remain outside this version.
- The clean-checkout restriction is deliberate. Dirty reconstruction belongs to
  issue #5 after the public seam exists.
- Adapter seams are test-facing inputs, not extra production lifecycle methods.

## Alternatives considered

The rejected lifecycle reducer would give each phase a separate public method.
That would leak ordering and allow callers to combine incompatible states.

Separate parser, fingerprint, planner, renderer, and sealer exports would make
each helper easy to call but would expose transport and private checkout shapes.
The chosen operation keeps those representations private and gives the caller a
single deep capability.

## Open questions and risks

Will a later Rote runtime require a different adapter vocabulary for interactive
confirmation? The decision port is intentionally small so that such a wrapper
can translate into it without changing proof facts.

Does the host provide Bubblewrap namespaces? The existing boundary remains the
authority and fails closed when it cannot prove isolation.

## Next implementation step

Implement the public operation and its end-to-end seam against controlled
adapters, then verify the same path with the real Linux boundary.
