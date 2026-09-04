---
status: accepted
---

# Run verification in isolated temporary snapshots

A proof run executes approved verification commands against an isolated temporary
snapshot reconstructed from the proof subject, not against the source checkout.
This prevents verification side effects from changing the code fingerprint or the
developer's working state, at the cost of reconstructing the checkout faithfully
and providing enforceable isolation.

## Evidence and scope

The prototype on branch `prototype/isolated-checkout` at commit `eab33f5` validated
this approach for an ordinary-file Node checkout on Linux. It reconstructed tracked
edits and a vetted untracked file, reused an existing Node dependency tree, produced
stable hashes across equivalent snapshots, ran the approved command with no recorded
network syscall, and left source worktree bytes, Git status, and dependency bytes
unchanged. The measurements are recorded in
`prototypes/isolated-checkout/RESULTS.md` at that commit.

The prototype did not validate submodules, Git LFS, sparse or linked worktrees,
symlinks, special files, unusual filenames, or cross-platform behaviour. Version
one must detect unsupported checkout shapes and stop before issuing a proof. It must
also stop without a proof on platforms where the required isolation cannot be
established; the Linux result does not imply a portable isolation mechanism.

## Considered alternative

Running commands directly in the source checkout avoids reconstruction and platform
isolation work, but allows approved commands to alter the exact state whose behaviour
they are meant to prove. That would make the resulting evidence untrustworthy, so
the simpler in-place approach is rejected.
