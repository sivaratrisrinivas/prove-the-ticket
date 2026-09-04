# prove-the-ticket

`prove-the-ticket` executes one approved Node command against an isolated reconstruction of a fingerprinted local checkout.

```js
import {executeProofCommand} from 'prove-the-ticket';

const result = await executeProofCommand({
  proofSubject,
  approvedCommand: command,
});
```

The executor returns either a typed `command-outcome` or a typed `run-error`. It never installs dependencies, runs in the source checkout, or issues a proof when Linux isolation is unavailable.

The execution-boundary contract and its adapter seams are documented in [`docs/architecture/execution-boundary.md`](docs/architecture/execution-boundary.md).

Run `npm test` for the deterministic public-seam tests. The Bubblewrap integration test skips when the host cannot create the required namespaces.
