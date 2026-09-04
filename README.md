# prove-the-ticket

`prove-the-ticket` is the execution boundary for later Play paths. It executes one approved Node command against an isolated reconstruction of a fingerprinted local checkout.

## What it does

The boundary accepts a committed tree, an optional binary tracked patch, approved untracked-file bytes, an optional existing dependency tree, and one approved command. It reconstructs the proof subject in a temporary workspace, checks the complete path/mode/content manifest, and returns a typed result.

Command results include the exit code, terminating signal or timeout state, bounded diagnostics, source-integrity status, network policy, and cleanup status. A timed-out result carries `COMMAND_TIMEOUT`. Run errors use fixed codes such as `SNAPSHOT_MISMATCH`, `ISOLATION_UNAVAILABLE`, `DEPENDENCIES_UNAVAILABLE`, `COMMAND_NOT_APPROVED`, and `SOURCE_CHANGED`.

## Why it exists

Proof must describe the fingerprinted checkout rather than whichever files happen to be present when a command runs. This boundary keeps the proof subject and existing dependencies read-only, gives the command a separate writable scratch directory, denies external networking, rejects dependency installation, and invalidates results if the source or dependency bytes change.

The implementation is the productionized execution boundary requested by [issue #2](https://github.com/sivaratrisrinivas/prove-the-ticket/issues/2). It intentionally does not contain GitHub issue orchestration or a later Play path.

## How to use it

```js
import {executeProofCommand} from 'prove-the-ticket';

const result = await executeProofCommand({
  proofSubject,
  approvedCommand: command,
});
```

`proofSubject` must contain an absolute checkout path, a full commit SHA, the repository-relative ordinary-file manifest, Git status, and any approved patch or untracked bytes. `command` must match `approvedCommand` exactly when supplied. Its working directory is repository-relative, its arguments remain separate, and its timeout is bounded to one hour.

The command receives `PROVE_THE_TICKET_SCRATCH_DIR` for writable output. The proof snapshot and dependency tree are mounted read-only. The default Linux adapter uses Bubblewrap with a separate process and network namespace, a cleared environment, and a timeout covering the contained process tree. If the host cannot establish those guarantees, the result is `ISOLATION_UNAVAILABLE` and no command is run.

Stdout and stderr are captured independently, masked before return, and limited to 64 KiB while retaining at most 32 KiB from each end. Binary streams are represented only by byte count and SHA-256. Private checkout, dependency, temporary, and scratch paths are replaced with `<local-checkout>` or `<temporary-snapshot>`.

The execution-boundary contract and its adapter seams are documented in [`docs/architecture/execution-boundary.md`](docs/architecture/execution-boundary.md).

## Verification

Run the checks from the repository root.

```sh
npm run check
npm test
```

The test suite covers dirty-tree reconstruction, stable snapshot hashes, dependency and source integrity, command approval, install rejection, typed exit/signal/timeout outcomes, output safety, cleanup, unsupported hosts, and the real Bubblewrap path. The Bubblewrap integration test skips when the host cannot create the required namespaces.
