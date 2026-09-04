#!/usr/bin/env bash
set -euo pipefail

# THROWAWAY PROTOTYPE: measure isolated reconstruction; do not reuse as production code.

export LC_ALL=C

for required_command in git node bwrap strace sha256sum find sort stat tar; do
  command -v "$required_command" >/dev/null || {
    printf 'missing required command: %s\n' "$required_command" >&2
    exit 1
  }
done

experiment_root=$(mktemp -d /tmp/prove-the-ticket-isolated-checkout.XXXXXX)
source_checkout="$experiment_root/source"
snapshot_one="$experiment_root/snapshot-one"
snapshot_two="$experiment_root/snapshot-two"
tracked_patch="$experiment_root/tracked.patch"

cleanup() {
  if [[ ${KEEP_PROTOTYPE_FIXTURE:-0} == 1 ]]; then
    printf 'fixture_retained=%s\n' "$experiment_root"
  else
    rm -rf -- "$experiment_root"
  fi
}
trap cleanup EXIT

hash_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

hash_worktree() {
  local root=$1
  (
    cd "$root"
    while IFS= read -r -d '' path; do
      relative_path=${path#./}
      if [[ -L $path ]]; then
        printf 'symlink\t%s\t%s\n' "$relative_path" "$(readlink -- "$path")"
      elif [[ -f $path ]]; then
        printf 'file\t%s\t%s\t%s\n' \
          "$relative_path" \
          "$(stat -c '%a' -- "$path")" \
          "$(hash_file "$path")"
      fi
    done < <(find . -path './.git' -prune -o \( -type f -o -type l \) -print0 | sort -z)
  ) | sha256sum | cut -d ' ' -f 1
}

hash_proof_state() {
  local root=$1
  shift
  local path
  {
    for path in "$@"; do
      printf '%s\t%s\t%s\n' \
        "$path" \
        "$(stat -c '%a' -- "$root/$path")" \
        "$(hash_file "$root/$path")"
    done
  } | sha256sum | cut -d ' ' -f 1
}

print_section() {
  printf '\n[%s]\n' "$1"
}

mkdir -p "$source_checkout/src" "$source_checkout/scripts"
git -C "$source_checkout" init -q
git -C "$source_checkout" config user.name 'Prototype Fixture'
git -C "$source_checkout" config user.email 'prototype@example.invalid'

cat >"$source_checkout/.gitignore" <<'EOF'
node_modules/
EOF
cat >"$source_checkout/package.json" <<'EOF'
{
  "name": "isolated-checkout-fixture",
  "private": true,
  "type": "module",
  "dependencies": {
    "prototype-check": "1.0.0"
  }
}
EOF
cat >"$source_checkout/package-lock.json" <<'EOF'
{
  "name": "isolated-checkout-fixture",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "dependencies": {
        "prototype-check": "1.0.0"
      }
    },
    "node_modules/prototype-check": {
      "version": "1.0.0"
    }
  }
}
EOF
cat >"$source_checkout/src/message.txt" <<'EOF'
committed tracked content
EOF
cat >"$source_checkout/scripts/verify.mjs" <<'EOF'
import {readFileSync} from 'node:fs';
import prototypeCheck from 'prototype-check';

const tracked = readFileSync('src/message.txt', 'utf8').trim();
const untracked = readFileSync('notes/safe.txt', 'utf8').trim();

if (tracked !== 'dirty tracked content') throw new Error('tracked edit missing');
if (untracked !== 'safe untracked content') throw new Error('safe untracked file missing');
if (prototypeCheck() !== 'installed dependency reused') throw new Error('toolchain unavailable');

console.log('approved_verification=PASS');
EOF

git -C "$source_checkout" add .gitignore package.json package-lock.json src/message.txt scripts/verify.mjs
GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
  git -C "$source_checkout" commit -qm 'Create deterministic fixture'

mkdir -p "$source_checkout/node_modules/prototype-check" "$source_checkout/notes"
cat >"$source_checkout/node_modules/prototype-check/package.json" <<'EOF'
{"name":"prototype-check","version":"1.0.0","main":"index.cjs"}
EOF
cat >"$source_checkout/node_modules/prototype-check/index.cjs" <<'EOF'
module.exports = () => 'installed dependency reused';
EOF
cat >"$source_checkout/src/message.txt" <<'EOF'
dirty tracked content
EOF
cat >"$source_checkout/notes/safe.txt" <<'EOF'
safe untracked content
EOF

# The fixture is complete. Integrity measurement starts here; no subsequent setup
# command is permitted to write to the source checkout.
source_status_before=$(git -C "$source_checkout" status --porcelain=v1 --untracked-files=all)
source_bytes_before=$(hash_worktree "$source_checkout")
toolchain_before=$(hash_worktree "$source_checkout/node_modules")
commit_sha=$(git -C "$source_checkout" rev-parse HEAD)
git -C "$source_checkout" diff --binary --full-index HEAD -- >"$tracked_patch"
tracked_patch_hash=$(hash_file "$tracked_patch")
lockfile_hash=$(hash_file "$source_checkout/package-lock.json")

mapfile -d '' tracked_paths < <(git -C "$source_checkout" ls-files -z | sort -z)
mapfile -d '' untracked_paths < <(git -C "$source_checkout" ls-files --others --exclude-standard -z | sort -z)

print_section 'untracked path preview (before content access)'
printf 'untracked_path=%s\n' "${untracked_paths[@]}"

safe_untracked=()
for path in "${untracked_paths[@]}"; do
  case "/$path" in
    */.env|*/.env.*|*/id_rsa|*/id_ed25519|*.pem|*/credentials|*/credentials.*)
      printf 'excluded_secret_like_path=%s\n' "$path"
      continue
      ;;
  esac
  [[ -f "$source_checkout/$path" && ! -L "$source_checkout/$path" ]] || {
    printf 'excluded_non_regular_path=%s\n' "$path"
    continue
  }
  size=$(stat -c '%s' -- "$source_checkout/$path")
  if ((size > 1048576)); then
    printf 'excluded_oversized_path=%s\n' "$path"
    continue
  fi
  safe_untracked+=("$path")
done

if ((${#safe_untracked[@]} != ${#untracked_paths[@]})); then
  printf 'fixture_error=an untracked fixture path was excluded\n' >&2
  exit 1
fi

proof_paths=("${tracked_paths[@]}" "${safe_untracked[@]}")
mapfile -t proof_paths < <(printf '%s\n' "${proof_paths[@]}" | sort)
source_proof_state_hash=$(hash_proof_state "$source_checkout" "${proof_paths[@]}")

reconstruct_snapshot() {
  local snapshot=$1
  mkdir -p "$snapshot"
  git -C "$source_checkout" archive --format=tar HEAD | tar -xf - -C "$snapshot"
  (
    cd "$snapshot"
    git apply "$tracked_patch"
  )
  if ((${#safe_untracked[@]})); then
    (
      cd "$source_checkout"
      cp --parents -- "${safe_untracked[@]}" "$snapshot"
    )
  fi
  ln -s "$source_checkout/node_modules" "$snapshot/node_modules"
}

reconstruct_snapshot "$snapshot_one"
reconstruct_snapshot "$snapshot_two"

snapshot_one_hash=$(hash_proof_state "$snapshot_one" "${proof_paths[@]}")
snapshot_two_hash=$(hash_proof_state "$snapshot_two" "${proof_paths[@]}")

approved_command=(node scripts/verify.mjs)
network_trace="$snapshot_one/.prototype-network.trace"

# Root is visible read-only, the temporary snapshot is writable, the installed
# dependency tree is explicitly read-only, and the command has a fresh network
# namespace. strace supplies independent evidence that it made no network syscall.
bwrap \
  --die-with-parent \
  --unshare-net \
  --ro-bind / / \
  --bind "$snapshot_one" "$snapshot_one" \
  --ro-bind "$source_checkout/node_modules" "$source_checkout/node_modules" \
  --proc /proc \
  --dev /dev \
  --chdir "$snapshot_one" \
  strace -f -qq -e trace=network -o "$network_trace" \
  "${approved_command[@]}"

network_syscall_count=$(wc -l <"$network_trace")
source_status_after=$(git -C "$source_checkout" status --porcelain=v1 --untracked-files=all)
source_bytes_after=$(hash_worktree "$source_checkout")
toolchain_after=$(hash_worktree "$source_checkout/node_modules")

print_section 'fixture state'
printf 'commit_sha=%s\n' "$commit_sha"
printf 'source_status_before<<STATUS\n%s\nSTATUS\n' "$source_status_before"
printf 'tracked_patch_hash=%s\n' "$tracked_patch_hash"
printf 'tracked_dirty_path=src/message.txt\n'
printf 'safe_untracked_path=%s\n' "${safe_untracked[@]}"
printf 'safe_untracked_hash=%s\n' "$(hash_file "$source_checkout/notes/safe.txt")"
printf 'lockfile_hash=%s\n' "$lockfile_hash"
printf 'node_version=%s\n' "$(node --version)"
printf 'npm_version=%s\n' "$(npm --version)"
printf 'git_version=%s\n' "$(git --version)"
printf 'operating_system=%s\n' "$(uname -srm)"
printf 'approved_command='
printf '%q ' "${approved_command[@]}"
printf '\n'

print_section 'hash comparisons'
printf 'source_proof_state_hash=%s\n' "$source_proof_state_hash"
printf 'snapshot_one_proof_state_hash=%s\n' "$snapshot_one_hash"
printf 'snapshot_two_proof_state_hash=%s\n' "$snapshot_two_hash"
printf 'source_bytes_before=%s\n' "$source_bytes_before"
printf 'source_bytes_after=%s\n' "$source_bytes_after"
printf 'toolchain_before=%s\n' "$toolchain_before"
printf 'toolchain_after=%s\n' "$toolchain_after"
printf 'source_status_after<<STATUS\n%s\nSTATUS\n' "$source_status_after"
printf 'network_syscall_count=%s\n' "$network_syscall_count"

[[ $source_proof_state_hash == "$snapshot_one_hash" && $snapshot_one_hash == "$snapshot_two_hash" ]]
[[ $source_bytes_before == "$source_bytes_after" ]]
[[ $toolchain_before == "$toolchain_after" ]]
[[ $source_status_before == "$source_status_after" ]]
[[ $network_syscall_count == 0 ]]

print_section 'constraint verdicts'
printf '1_capture_tracked_and_safe_untracked=PASS\n'
printf '2_temporary_exact_reconstruction=PASS\n'
printf '3_reuse_installed_node_toolchain=PASS\n'
printf '4_no_install_and_no_verification_network=PASS\n'
printf '5_stable_equivalent_snapshot_hashes=PASS\n'
printf '6_source_checkout_unchanged=PASS\n'
printf 'overall=PASS\n'
