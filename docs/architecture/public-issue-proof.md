# Public issue proof

Issue #5 extends the public `runIssueProof` operation from issue #4. The caller
supplies a full GitHub issue URL, a local checkout, and one or more existing Node
verification commands. Each command maps to one or more existing acceptance
criteria. Injected GitHub, decision, checkout, and environment adapters keep the
complete path deterministic in tests. Boundary options can inject the existing
execution-boundary isolation adapter without allowing callers to replace the
boundary itself.

## Caller usage

```js
const result = await runIssueProof({
  issueUrl: 'https://github.com/owner/repository/issues/42',
  checkoutPath: '/work/repository',
  commands: [
    {executable: 'npm', args: ['run', 'check'], criteria: ['criterion-1']},
    {executable: 'npm', args: ['test'], criteria: ['criterion-2']},
  ],
}, {
  github: {readIssue},
  decisions: {confirmCriteria, confirmUntracked, approvePlan},
});
```

The caller receives a versioned JSON result, a restrained proof card, and a
deterministic proof seal for a trustworthy run. A rejected confirmation or a
pre-result safety failure returns a typed run error without an overall status or
seal. When the checkout has non-ignored untracked paths, `confirmUntracked`
must approve their metadata-only preview before any eligible content is read.

## Shape

The operation owns the lifecycle in this order: parse and anonymously read the
public issue, normalize and match the checkout remote, extract and confirm the
existing criteria, capture staged and unstaged tracked state, preview and
approve untracked paths before reading eligible bytes, fingerprint the checkout,
build and approve an independent command plan, execute every command through the
issue #2 boundary, classify each outcome, aggregate each mapped criterion, and
assemble the public artifacts.

The plan contains ordered command entries with identity-derived IDs, normalized
command identities, and criterion-ID mappings. A command mapping is explicit when the
caller supplies `criteria`. Otherwise the operation maps the command to every
criterion. Plan edits change the plan hash and return the plan to `PENDING`
approval. The operation presents the revised full plan before it executes any
command.

The public operation invokes the lower-level boundary once per command. One
failed, timed-out, or policy-blocked command does not prevent another approved
command from running. A criterion fails when any mapped command fails. It stays
unverified when no command is mapped or when a mapped command has no trustworthy
outcome, unless another mapped command has already failed it.

The domain is represented by a proof subject containing the criteria hash and a
repository-only code fingerprint. The executor receives a separate private
subject containing the absolute checkout path, manifest, patch bytes, included
untracked bytes, all observed untracked paths, and dependency location. This
separation keeps local operational state and excluded path contents out of
shareable JSON. An incomplete fingerprint is a qualified run and forces
`INCOMPLETE`; snapshot, unsupported-shape, freshness, or isolation failures
remain run errors with no status or seal.

Criteria, fingerprints, plans, and seal facts use one strict RFC 8785 canonical JSON serializer before hashing; invalid Unicode, sparse arrays, unsupported values, and non-finite numbers are rejected.
The seal projection includes only stable proof facts. Output excerpts,
timestamps, durations, run IDs, formatting, and filesystem paths stay outside
the seal. Rendering sanitizes checkout and temporary paths and never includes
untracked content.

The ordered artifact fields and closed enum values form the shareable
compatibility contract. Omitted fields and `null` values remain distinct. The
repository-only code fingerprint exposes only its documented fields; dependency
bytes remain bound in the executor's private subject and are not emitted as a
fingerprint or execution-environment field.

## Synthesis decision

The existing execution boundary is the only trusted command-running capability.
The ordered plan shape extends the existing plan without adding a second
execution lifecycle.

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
- The inspector owns dirty-state policy and path preview. The execution boundary
  only reconstructs the approved private subject.
- The plan accepts only independent automated commands. Dependencies and output
  selection remain outside version one.
- Adapter seams are test-facing inputs, not extra production lifecycle methods.

## Alternatives considered

The rejected lifecycle reducer would give each phase a separate public method.
That would leak ordering and allow callers to combine incompatible states.

Separate parser, fingerprint, planner, renderer, and sealer exports would make
each helper easy to call but would expose transport and private checkout shapes.
The chosen operation keeps those representations private and gives the caller a
single deep capability.

A criterion-centric matrix would make aggregation direct, but it would duplicate
command definitions for shared commands and force the caller to reconcile two
ordered views. The command list remains the single plan source of truth, while
criterion results derive from its mappings.

## Open questions and risks

Will a later Rote runtime require a different adapter vocabulary for interactive
confirmation? The decision port is intentionally small so that such a wrapper
can translate into it without changing proof facts.

Does the host provide Bubblewrap namespaces? The existing boundary remains the
authority and fails closed when it cannot prove isolation.

## Next implementation step

Implement the public operation and its end-to-end seam against controlled
adapters, then verify the same path with the real Linux boundary.
