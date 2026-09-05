# Execution boundary

The production boundary runs one approved verification command for later Play paths.

## Public seam

The caller gives `executeProofCommand` a fingerprinted `proofSubject` and an approved command. A caller that keeps a separate current command can pass it as `command`; the executor compares both commands before it touches the checkout.

```js
const result = await executeProofCommand({
  proofSubject,
  approvedCommand,
});
```

The subject contains the private local checkout path, commit, tracked patch bytes, an ordinary-file manifest, approved untracked file bytes, all observed untracked paths, and an optional existing dependency tree. The command contains the executable, argument boundaries, repository-relative working directory, timeout, and environment policy. The public inspection layer owns path preview, approval, secret exclusion, and size limits.

The caller receives one of two result shapes.

- `command-outcome` records an exit code, a signal, or a timeout, bounded diagnostic output, source integrity, network policy, warnings, and cleanup.
- A timed-out `command-outcome` also carries `code: COMMAND_TIMEOUT`.
- `run-error` records a fixed error code and no overall proof status or seal.

The executor hides temporary paths, archive extraction, process containment, output handling, and cleanup from callers.

## Lifecycle ownership

The executor validates the subject and command at the boundary. It rejects install commands before isolation or command process creation. It then captures the source state, checks the host capability, creates temporary snapshot and scratch directories, reconstructs the committed tree, applies the binary tracked patch, and copies approved untracked bytes.

The executor compares the reconstructed manifest with the subject before it calls the isolation adapter. The default Linux adapter mounts the snapshot and dependency tree read-only, mounts scratch space writable, clears the command environment, creates a network and process namespace with Bubblewrap, and starts the exact approved executable.

The executor drains both output streams into bounded buffers. It retains at most 32 KiB from each end of a 64 KiB stream. It masks credential values, included untracked text, and private paths before it returns output. Binary output becomes a byte count and SHA-256 hash.

After the command exits, the executor recomputes the commit, tracked patch, Git status, proof manifest, and dependency digest. Any change returns `SOURCE_CHANGED` and discards the command result. A `finally`-equivalent cleanup step removes the temporary workspace for every path after workspace creation.

## Data shape

The manifest is the central proof-subject structure. Each entry has a repository-relative path, permission mode, and SHA-256 content hash. Snapshot verification sorts entries by path and compares the complete canonical manifest reconstructed from the commit, binary tracked patch, and approved untracked files. Excluded untracked paths remain path-only state for source matching and cannot make a fingerprint `PROVED`.

Execution states form a closed set: `EXITED`, `SIGNALED`, and `TIMED_OUT`. Run errors use fixed codes such as `SNAPSHOT_MISMATCH`, `ISOLATION_UNAVAILABLE`, `DEPENDENCIES_UNAVAILABLE`, and `SOURCE_CHANGED`. This keeps command failure distinct from a run that could not produce trustworthy evidence.

The public result contains no exact checkout, snapshot, dependency, or scratch path. Diagnostics use `<local-checkout>` and `<temporary-snapshot>`.

## Design decision

The selected shape is one deep `executeProofCommand` operation backed by one private Bubblewrap adapter. It keeps lifecycle decisions together because reconstruction, freshness, process containment, output persistence, and cleanup must agree about one proof subject. The adapter seam gives tests a deterministic process result without weakening the production capability check.

## Tradeoffs

- The boundary accepts subject bytes for approved untracked files. This keeps the executor from deciding which untracked paths are safe and leaves path preview and approval to the fingerprinting layer.
- The default adapter uses Bubblewrap and Linux namespaces. Other platforms fail closed until they have an equivalent capability.
- The snapshot is mounted read-only. Commands that need generated files must use `PROVE_THE_TICKET_SCRATCH_DIR`.
- Existing dependencies are reused from the source checkout through a read-only mount. The executor never repairs or installs them.

## Alternatives rejected

A staged API with separate `capture`, `reconstruct`, `run`, and `cleanup` calls would expose lifecycle ordering to every caller. It loses interface depth and makes cleanup and freshness easier to omit.

A copied dependency tree would simplify mount setup but would add a second mutable representation of the dependency state. The read-only mount preserves the source dependency bytes and matches ADR-0001.

The prototype shell script is not imported. It remains experimental evidence, while the production module owns typed request validation, policy decisions, and test seams.

## Risks

Bubblewrap capability depends on host kernel policy. The executor reports `ISOLATION_UNAVAILABLE` when the namespace probe fails. The real integration test remains capability-gated for the same reason.

The output mask covers supplied environment values, common token forms, private keys, credential-bearing URLs, and secret assignment patterns. Later Play paths must pass adapter-specific secrets through `redactionValues` before they execute commands.
