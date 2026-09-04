# Isolated checkout prototype results

Measured on 2026-09-04. Two consecutive executions produced the same fixture
identity and all hashes below.

## Method attempted

1. Create a deterministic temporary Git repository containing a minimal Node
   project and a pre-existing dependency under ignored `node_modules`.
2. Make one tracked edit and add one safe, non-ignored untracked file.
3. Start source-integrity measurement, preview untracked paths, reject unsafe or
   oversized paths, then capture the committed tree with `git archive` and the
   tracked changes with `git diff --binary --full-index HEAD`.
4. Reconstruct two temporary snapshots by extracting the archive, applying the
   patch, copying the approved untracked file, and linking the installed
   `node_modules` into each snapshot.
5. Run the approved `node scripts/verify.mjs` command in the first snapshot with
   Bubblewrap: a new network namespace, a read-only root, a writable snapshot,
   and an explicitly read-only source `node_modules`. Trace all network syscalls.
6. Compare canonical path/mode/content hashes across the source proof subject and
   both snapshots. Compare source worktree bytes, source Git status, and installed
   toolchain bytes before and after the proof run.

No dependency-install command was invoked. The only approved verification command
was `node scripts/verify.mjs`.

## Fixture state

```text
commit_sha=575f67e75ab20bfa7c0019c0a0a9d0cf023b69a6
source_status_before:
 M src/message.txt
?? notes/safe.txt
tracked_dirty_path=src/message.txt
safe_untracked_path=notes/safe.txt
tracked_patch_hash=dba3d68f80c004e7497b8340ea34913d8ee2bb90bb86745cbe5cb505d5038f84
safe_untracked_hash=cc9f4f773c8f17c28390c024225cc14f3e997958f67b9e90c7b5fbf913833606
lockfile_hash=3d8c57c46f1a32565d5f8265e9aca13320473ebc803ed2c2bdb6448cff53cc0e
node_version=v22.14.0
npm_version=10.9.2
git_version=2.34.1
operating_system=Linux 6.18.33.2-microsoft-standard-WSL2 x86_64
```

## Comparisons

```text
source_proof_state_hash=2dbe85eca129b46d81b6fc793c1173a079cbe376131318771633f14058cc23c9
snapshot_one_proof_state_hash=2dbe85eca129b46d81b6fc793c1173a079cbe376131318771633f14058cc23c9
snapshot_two_proof_state_hash=2dbe85eca129b46d81b6fc793c1173a079cbe376131318771633f14058cc23c9

source_bytes_before=6851acc038d14ce0a171af0af9b8f9f7d4888ba7969c9a30f70f711dea18936f
source_bytes_after=6851acc038d14ce0a171af0af9b8f9f7d4888ba7969c9a30f70f711dea18936f

toolchain_before=7e32503a9464e30db8558f0d7697e87a59ce7f33a9fc6beee34410dc48651e14
toolchain_after=7e32503a9464e30db8558f0d7697e87a59ce7f33a9fc6beee34410dc48651e14

source_status_after:
 M src/message.txt
?? notes/safe.txt

network_syscall_count=0
approved_verification=PASS
```

## Constraint verdicts

| Constraint | Verdict | Evidence |
| --- | --- | --- |
| Capture tracked edits and safe untracked files | PASS | The binary patch and safe-file hashes were captured after path preview. |
| Reconstruct the exact state temporarily | PASS | Both snapshot proof-state hashes equal the source proof-state hash. |
| Reuse the installed Node toolchain | PASS | The verifier imported the linked installed dependency; its before/after tree hashes match. |
| No install and no verification-command network access | PASS | No install command ran; Bubblewrap removed external networking and `strace` recorded zero network syscalls. |
| Stable hashes across equivalent snapshots | PASS | Both snapshots and both complete executions produced the same proof-state hash. |
| Source checkout remains unchanged | PASS | Worktree byte hashes and porcelain Git status match before and after. |

Overall: **PASS**.

## Limitations

- The fixture covers ordinary tracked and untracked files only. It does not measure
  submodules, sparse checkouts, Git LFS, linked worktrees, symlinks, special files,
  or filenames containing newlines.
- Toolchain reuse is demonstrated with a deterministic pre-populated fixture
  dependency, not a package installed from a registry during this experiment.
- Network denial depends on Linux user/network namespaces and Bubblewrap. A portable
  implementation needs a platform-specific isolation strategy or must declare the
  platform unsupported.
- The network trace proves this approved command made no network syscall. Other
  commands must be measured independently; package-manager lifecycle behavior was
  intentionally not exercised.
- The worktree byte hash excludes `.git` metadata. Git status was compared
  separately because read-only Git operations may legitimately touch internal
  metadata on some configurations without changing the proof subject.

## Smallest justified conclusion

For the measured Linux fixture, `git archive` plus a full binary tracked patch,
vetted untracked-file copying, and a read-only link to the existing Node dependency
tree can reconstruct equivalent temporary proof subjects and run a Node verification
command without network syscalls or source-checkout changes. This validates the
isolated-snapshot direction for the ordinary-file Node case only; the limitations
above remain design inputs rather than proven behavior.
