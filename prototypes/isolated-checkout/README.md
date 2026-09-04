# Isolated checkout prototype

> Throwaway prototype. This is experimental evidence, not production code.

## Question

Can a proof run capture a dirty local checkout, reconstruct its tracked edits and
safe untracked files in a temporary snapshot, reuse its already-installed Node
toolchain, run approved verification commands without network access or dependency
installation, produce stable hashes for equivalent snapshots, and leave the source
checkout unchanged?

The prototype creates its own deterministic fixture under `/tmp`; it never uses the
repository containing this file as the proof subject.

## Run

```sh
bash prototypes/isolated-checkout/run.sh
```

The script prints the complete measured state and a six-row verdict. It requires
Git, Node, `bwrap`, `strace`, and common GNU utilities. Bubblewrap provides a network
namespace with no external interfaces and read-only access to the fixture's
`node_modules`; `strace` records whether the approved command attempted any network
system call.

## Deliberately narrow scope

- One Git worktree with ordinary files; submodules, sparse checkouts, Git LFS,
  symlinks, and filenames containing newlines are not exercised.
- One approved Node command is executed directly; package-manager lifecycle scripts
  are not exercised.
- Safe untracked files are regular files no larger than 1 MiB whose path does not
  match the prototype's small secret-name denylist.
- The source byte comparison covers worktree file contents, modes, and symlink
  targets, excluding `.git` metadata. Git status is compared separately.
