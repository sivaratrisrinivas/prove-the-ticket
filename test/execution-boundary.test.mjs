import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {executeProofCommand} from '../src/index.js';

const execFileAsync = promisify(execFile);

test('reconstructs a dirty proof subject and returns an exit outcome', async () => {
  const fixture = await createFixture({dirty: true});
  const seen = [];
  const result = await executeProofCommand(fixture.request, {
    isolation: adapter(async (context) => {
      seen.push(context);
      assert.equal(await fs.readFile(path.join(context.snapshotPath, 'src/message.txt'), 'utf8'), 'dirty\n');
      assert.equal(await fs.readFile(path.join(context.snapshotPath, 'notes/safe.txt'), 'utf8'), 'safe\n');
      return {state: 'EXITED', exitCode: 0, signal: null, stdout: Buffer.from('pass\n'), stderr: Buffer.alloc(0)};
    }),
  });

  assert.equal(result.kind, 'command-outcome');
  assert.equal(result.execution.state, 'EXITED');
  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.sourceIntegrity, 'UNCHANGED');
  assert.equal(result.cleanup.state, 'CLEANED');
  assert.equal(seen.length, 1);
  assert.equal(await fs.readFile(path.join(fixture.root, 'src/message.txt'), 'utf8'), 'dirty\n');
  assert.equal(await fs.readFile(path.join(fixture.root, 'notes/safe.txt'), 'utf8'), 'safe\n');
  await remove(fixture.root);
});

test('reconstructs the same fingerprint to a stable snapshot hash', async () => {
  const fixture = await createFixture({dirty: true});
  const snapshotHashes = [];
  try {
    for (let run = 0; run < 2; run += 1) {
      const result = await executeProofCommand(fixture.request, {
        isolation: adapter(async (context) => {
          snapshotHashes.push(await snapshotHash(context.snapshotPath));
          return {state: 'EXITED', exitCode: 0, signal: null};
        }),
      });
      assert.equal(result.kind, 'command-outcome');
      assert.equal(result.execution.exitCode, 0);
    }
    assert.equal(snapshotHashes.length, 2);
    assert.equal(snapshotHashes[0], snapshotHashes[1]);
  } finally {
    await remove(fixture.root);
  }
});

test('reconstructs a binary tracked patch', async () => {
  const fixture = await createFixture({binary: true});
  try {
    const result = await executeProofCommand(fixture.request, {
      isolation: adapter(async (context) => {
        assert.deepEqual(
          await fs.readFile(path.join(context.snapshotPath, 'src/blob.bin')),
          Buffer.from([0, 255, 1, 254, 2]),
        );
        return {state: 'EXITED', exitCode: 0, signal: null};
      }),
    });

    assert.equal(result.kind, 'command-outcome');
    assert.equal(result.execution.exitCode, 0);
  } finally {
    await remove(fixture.root);
  }
});

test('masks credentials and private paths before persistence', async () => {
  const fixture = await createFixture();
  const result = await executeProofCommand(fixture.request, {
    isolation: adapter(async (context) => ({
      state: 'EXITED',
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(`token=top-secret path=${context.sourcePath}\n`),
      stderr: Buffer.alloc(0),
    })),
  });

  assert.equal(result.kind, 'command-outcome');
  assert.equal(result.output.streams.stdout.excerpt.includes('top-secret'), false);
  assert.equal(result.output.streams.stdout.excerpt.includes(fixture.root), false);
  assert.match(result.output.streams.stdout.excerpt, /<redacted>/);
  assert.deepEqual(result.warnings, [{code: 'VALUE_REDACTED', stream: 'stdout'}]);
  await remove(fixture.root);
});

test('bounds text output while retaining both ends', async () => {
  const fixture = await createFixture();
  const result = await executeProofCommand(fixture.request, {
    isolation: adapter(async () => ({
      state: 'EXITED',
      exitCode: 0,
      signal: null,
      stdout: Buffer.concat([Buffer.alloc(32768, 'a'), Buffer.alloc(32768, 'b'), Buffer.from('tail')]),
      stderr: Buffer.alloc(0),
    })),
  });

  const stream = result.output.streams.stdout;
  assert.equal(stream.byteCount, 65540);
  assert.equal(stream.truncated, true);
  assert.equal(Buffer.byteLength(stream.excerpt) <= 4096, true);
  assert.equal(stream.excerpt.startsWith('a'), true);
  assert.equal(stream.excerpt.endsWith('tail'), true);
  assert.match(stream.excerpt, /b+tail$/);
  assert.deepEqual(result.warnings, [{code: 'OUTPUT_TRUNCATED', stream: 'stdout'}]);
  await remove(fixture.root);
});

test('summarizes binary output without rendering it', async () => {
  const fixture = await createFixture();
  const bytes = Buffer.from([0, 1, 2, 3]);
  const result = await executeProofCommand(fixture.request, {
    isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null, stdout: bytes, stderr: Buffer.alloc(0)})),
  });

  assert.equal(result.output.streams.stdout.binary, true);
  assert.equal(result.output.streams.stdout.excerpt, null);
  assert.equal(result.output.streams.stdout.byteCount, bytes.length);
  assert.equal(result.output.streams.stdout.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.warnings, [{code: 'BINARY_OUTPUT_OMITTED', stream: 'stdout'}]);
  await remove(fixture.root);
});

test('rejects install commands before isolation or process creation', async () => {
  const fixture = await createFixture();
  let executions = 0;
  const command = {...fixture.request.command, executable: 'npm', args: ['install']};
  const result = await executeProofCommand({...fixture.request, approvedCommand: command, command}, {
    isolation: {
      check: async () => ({available: true}),
      execute: async () => {
        executions += 1;
        return {state: 'EXITED', exitCode: 0, signal: null};
      },
    },
  });

  assert.equal(result.kind, 'run-error');
  assert.equal(result.code, 'INSTALL_COMMAND_REJECTED');
  assert.equal(executions, 0);
  await remove(fixture.root);
});

test('rejects yarn dlx and unrelated absolute command paths before isolation', async () => {
  const fixture = await createFixture();
  let checked = 0;
  try {
    const isolation = {
      check: async () => { checked += 1; return {available: true}; },
      execute: async () => ({state: 'EXITED', exitCode: 0, signal: null}),
    };
    const yarn = {...fixture.request.command, executable: 'yarn', args: ['dlx', 'package']};
    const yarnResult = await executeProofCommand({...fixture.request, approvedCommand: yarn, command: yarn}, {isolation});
    assert.equal(yarnResult.code, 'INSTALL_COMMAND_REJECTED');

    const corepack = {...fixture.request.command, executable: 'corepack', args: ['yarn', 'add', 'package']};
    const corepackResult = await executeProofCommand({...fixture.request, approvedCommand: corepack, command: corepack}, {isolation});
    assert.equal(corepackResult.code, 'INSTALL_COMMAND_REJECTED');

    const absolute = {...fixture.request.command, executable: path.join(fixture.root, 'run.js')};
    const absoluteResult = await executeProofCommand({...fixture.request, approvedCommand: absolute, command: absolute}, {isolation});
    assert.equal(absoluteResult.code, 'COMMAND_NOT_APPROVED');

    const argument = {...fixture.request.command, args: [path.join(fixture.root, 'secret.txt')]};
    const argumentResult = await executeProofCommand({...fixture.request, approvedCommand: argument, command: argument}, {isolation});
    assert.equal(argumentResult.code, 'COMMAND_NOT_APPROVED');
    assert.equal(checked, 0);
  } finally {
    await remove(fixture.root);
  }
});

test('fails closed for stale manifests and timeout values outside policy', async () => {
  const fixture = await createFixture();
  let checked = 0;
  try {
    const isolation = {
      check: async () => { checked += 1; return {available: true}; },
      execute: async () => ({state: 'EXITED', exitCode: 0, signal: null}),
    };
    const stale = {
      ...fixture.request,
      proofSubject: {
        ...fixture.request.proofSubject,
        manifest: fixture.request.proofSubject.manifest.map((entry, index) => index === 0 ? {...entry, sha256: '0'.repeat(64)} : entry),
      },
    };
    const staleResult = await executeProofCommand(stale, {isolation});
    assert.equal(staleResult.code, 'SNAPSHOT_MISMATCH');

    for (const timeoutSeconds of [0, 3601]) {
      const command = {...fixture.request.command, timeoutSeconds};
      const result = await executeProofCommand({...fixture.request, approvedCommand: command, command}, {isolation});
      assert.equal(result.code, 'COMMAND_NOT_APPROVED');
    }
    assert.equal(checked, 0);
  } finally {
    await remove(fixture.root);
  }
});

test('rejects unsupported checkout shapes with fixed subtypes before isolation', async () => {
  await assertUnsupportedSubtype(async (root) => {
    await fs.rm(path.join(root, 'src/message.txt'));
    await fs.symlink('missing.txt', path.join(root, 'src/message.txt'));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'tracked symlink']);
  }, 'SYMLINK');

  await assertUnsupportedSubtype(async (root) => {
    const commitSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    await git(root, ['update-index', '--add', '--cacheinfo', `160000,${commitSha},vendor/submodule`]);
    await git(root, ['commit', '-qm', 'submodule']);
  }, 'SUBMODULE');

  await assertUnsupportedSubtype(async (root) => {
    await fs.writeFile(path.join(root, '.gitattributes'), '*.lfs filter=lfs\n');
    await fs.writeFile(path.join(root, 'asset.lfs'), 'pointer\n');
    await git(root, ['add', '.gitattributes', 'asset.lfs']);
    await git(root, ['commit', '-qm', 'lfs']);
  }, 'GIT_LFS');

  await assertUnsupportedSubtype(async (root) => {
    await git(root, ['config', 'core.sparseCheckout', 'true']);
  }, 'SPARSE_CHECKOUT');
  await assertUnsupportedObservedPath('../outside', 'PATH_TRAVERSAL');
  await assertUnsupportedObservedPath('bad\npath', 'CONTROL_CHARACTER_PATH');
  await assertMalformedGitTree(Buffer.from('100644 mystery\tfile\0'), 'UNKNOWN_ENTRY_TYPE');
  await assertMalformedGitTree(Buffer.from([0x31, 0x30, 0x30, 0x36, 0x34, 0x34, 0x20, 0x62, 0x6c, 0x6f, 0x62, 0x09, 0xff, 0x00]), 'NON_UTF8_PATH');

  const fixture = await createFixture();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-linked-parent-'));
  const linked = path.join(parent, 'worktree');
  try {
    await git(fixture.root, ['worktree', 'add', '--detach', '-q', linked, 'HEAD']);
    await assertUnsupportedSubtypeAtPath(linked, 'LINKED_WORKTREE');
  } finally {
    await fs.rm(linked, {recursive: true, force: true});
    await remove(parent);
    await remove(fixture.root);
  }
});

test('redacts explicit environment values even when they are short', async () => {
  const fixture = await createFixture();
  const command = {...fixture.request.command, environmentPolicy: {variables: {TOKEN: 'x'}}};
  try {
    const result = await executeProofCommand({...fixture.request, approvedCommand: command, command}, {
      isolation: adapter(async () => ({
        state: 'EXITED',
        exitCode: 0,
        signal: null,
        stdout: Buffer.from('x\n'),
        stderr: Buffer.alloc(0),
      })),
    });
    assert.equal(result.output.streams.stdout.excerpt, '<redacted>\n');
    assert.equal(result.command.environmentPolicy.variables.TOKEN, '<redacted>');
    assert.deepEqual(result.warnings, [{code: 'VALUE_REDACTED', stream: 'stdout'}]);
  } finally {
    await remove(fixture.root);
  }
});

test('clips long UTF-8 output without replacement characters', async () => {
  const fixture = await createFixture();
  const output = Buffer.from(`a${'😀'.repeat(20000)}z`);
  try {
    const result = await executeProofCommand(fixture.request, {
      isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null, stdout: output, stderr: Buffer.alloc(0)})),
    });
    const excerpt = result.output.streams.stdout.excerpt;
    assert.equal(excerpt.includes('\ufffd'), false);
    assert.equal(Buffer.byteLength(excerpt) <= 4096, true);
  } finally {
    await remove(fixture.root);
  }
});

test('rejects a command changed after approval', async () => {
  const fixture = await createFixture();
  const result = await executeProofCommand({...fixture.request, command: {...fixture.request.command, args: ['-e', 'changed']}}, {
    isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null})),
  });

  assert.equal(result.kind, 'run-error');
  assert.equal(result.code, 'COMMAND_NOT_APPROVED');
  await remove(fixture.root);
});

test('returns typed isolation and dependency failures', async () => {
  const fixture = await createFixture();
  const unavailable = await executeProofCommand(fixture.request, {
    isolation: {
      check: async () => ({available: false, reason: 'test capability unavailable'}),
      execute: async () => ({state: 'EXITED', exitCode: 0, signal: null}),
    },
  });
  assert.equal(unavailable.code, 'ISOLATION_UNAVAILABLE');

  const dependencyRequest = {
    ...fixture.request,
    proofSubject: {
      ...fixture.request.proofSubject,
      dependencyTree: {sourcePath: path.join(fixture.root, 'missing-node-modules')},
    },
  };
  const missing = await executeProofCommand(dependencyRequest, {
    isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null})),
  });
  assert.equal(missing.code, 'DEPENDENCIES_UNAVAILABLE');
  await remove(fixture.root);
});

test('returns timeout and signal outcomes distinctly', async () => {
  const fixture = await createFixture();
  const timeout = await executeProofCommand(fixture.request, {
    isolation: adapter(async () => ({state: 'TIMED_OUT', exitCode: null, signal: 'SIGKILL'})),
  });
  assert.equal(timeout.execution.state, 'TIMED_OUT');
  assert.equal(timeout.code, 'COMMAND_TIMEOUT');
  assert.equal(timeout.execution.exitCode, null);

  const signal = await executeProofCommand(fixture.request, {
    isolation: adapter(async () => ({state: 'SIGNALED', exitCode: null, signal: 'SIGTERM'})),
  });
  assert.equal(signal.execution.state, 'SIGNALED');
  assert.equal(signal.execution.signal, 'SIGTERM');
  await remove(fixture.root);
});

test('reports temporary-workspace cleanup failures without hiding the command outcome', async () => {
  const fixture = await createFixture();
  try {
    const result = await executeProofCommand(fixture.request, {
      cleanup: async (rootPath) => {
        await fs.rm(rootPath, {recursive: true, force: true});
        throw new Error('cleanup failure');
      },
      isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null})),
    });

    assert.equal(result.kind, 'command-outcome');
    assert.equal(result.execution.exitCode, 0);
    assert.deepEqual(result.cleanup, {
      state: 'FAILED',
      code: 'INTERNAL_EXECUTION_ERROR',
      message: 'cleanup failure',
    });
  } finally {
    await remove(fixture.root);
  }
});

test('discards apparent command results when the source changes', async () => {
  const fixture = await createFixture();
  const result = await executeProofCommand(fixture.request, {
    isolation: adapter(async (context) => {
      await fs.writeFile(path.join(context.sourcePath, 'src/message.txt'), 'mutated\n');
      return {state: 'EXITED', exitCode: 0, signal: null, stdout: Buffer.from('pass')};
    }),
  });

  assert.equal(result.kind, 'run-error');
  assert.equal(result.code, 'SOURCE_CHANGED');
  assert.equal(result.sourceIntegrity, 'CHANGED');
  assert.equal(result.proofSeal, null);
  assert.equal(result.cleanup.state, 'CLEANED');
  await remove(fixture.root);
});

test('checks source integrity when isolation fails internally', async () => {
  const fixture = await createFixture();
  try {
    const result = await executeProofCommand(fixture.request, {
      isolation: adapter(async (context) => {
        await fs.writeFile(path.join(context.sourcePath, 'src/message.txt'), 'mutated\n');
        throw new Error('adapter failed');
      }),
    });

    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'SOURCE_CHANGED');
    assert.equal(result.sourceIntegrity, 'CHANGED');
    assert.equal(result.proofSeal, null);
    assert.equal(result.cleanup.state, 'CLEANED');
  } finally {
    await remove(fixture.root);
  }
});

test('fails closed on unsupported platforms', async () => {
  const fixture = await createFixture();
  let checked = false;
  const result = await executeProofCommand(fixture.request, {
    platform: 'darwin',
    isolation: {
      check: async () => {
        checked = true;
        return {available: true};
      },
      execute: async () => ({state: 'EXITED', exitCode: 0, signal: null}),
    },
  });

  assert.equal(result.code, 'UNSUPPORTED_PLATFORM');
  assert.equal(checked, false);
  await remove(fixture.root);
});

test('runs the real Bubblewrap path when the host can provide it', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux is required.');
  const fixture = await createFixture();
  const dependencyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-dependency-'));
  await fs.writeFile(path.join(dependencyRoot, 'package.json'), '{"name":"fixture-dependency"}\n');
  const command = {
    executable: process.execPath,
    args: ['-e', "(async () => { const fs = require('node:fs'); const net = require('node:net'); const crypto = require('node:crypto'); let sourceReadOnly = false; try { fs.writeFileSync('src/message.txt', 'changed'); } catch { sourceReadOnly = true; } const dependency = fs.readFileSync('node_modules/package.json', 'utf8'); let dependencyReadOnly = false; try { fs.writeFileSync('node_modules/package.json', 'changed'); } catch { dependencyReadOnly = true; } const networkBlocked = await new Promise((resolve) => { const socket = net.createConnection({host: '198.51.100.1', port: 80}); const finish = (blocked) => { socket.destroy(); resolve(blocked); }; socket.once('connect', () => finish(false)); socket.once('error', () => finish(true)); socket.setTimeout(250, () => finish(true)); }); if (!sourceReadOnly || !dependencyReadOnly || dependency !== '{\"name\":\"fixture-dependency\"}\\n' || !networkBlocked) process.exit(2); fs.writeFileSync(require('node:path').join(process.env.PROVE_THE_TICKET_SCRATCH_DIR, 'result.txt'), 'ok'); process.stdout.write(crypto.createHash('sha256').update(dependency).digest('hex') + '\\n'); })().catch((error) => { console.error(error); process.exit(1); });"],
    cwd: '.',
    timeoutSeconds: 3,
  };
  const request = {
    ...fixture.request,
    proofSubject: {
      ...fixture.request.proofSubject,
      dependencyTree: {
        sourcePath: dependencyRoot,
        requiredPaths: ['package.json'],
      },
    },
    approvedCommand: command,
    command,
  };
  try {
    const results = [];
    for (let run = 0; run < 2; run += 1) {
      const result = await executeProofCommand(request);
      if (result.code === 'ISOLATION_UNAVAILABLE') {
        return t.skip('The host cannot establish Bubblewrap namespaces.');
      }
      results.push(result);
    }
    for (const result of results) {
      assert.equal(result.kind, 'command-outcome');
      assert.equal(result.execution.exitCode, 0);
      assert.match(result.output.streams.stdout.excerpt, /^[0-9a-f]{64}\n$/);
    }
    assert.equal(results[0].output.streams.stdout.excerpt, results[1].output.streams.stdout.excerpt);
    assert.equal(await fs.readFile(path.join(dependencyRoot, 'package.json'), 'utf8'), '{"name":"fixture-dependency"}\n');
  } finally {
    await remove(fixture.root);
    await remove(dependencyRoot);
  }
});

test('runs a package-manager executable from the Node runtime directory', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux is required.');
  const fixture = await createFixture();
  const command = {
    executable: 'npm',
    args: ['--version'],
    cwd: '.',
    timeoutSeconds: 3,
  };
  try {
    const result = await executeProofCommand({...fixture.request, approvedCommand: command, command});
    if (result.code === 'ISOLATION_UNAVAILABLE') {
      return t.skip('The host cannot establish Bubblewrap namespaces.');
    }
    assert.equal(result.kind, 'command-outcome');
    assert.equal(result.execution.exitCode, 0);
    assert.match(result.output.streams.stdout.excerpt, /^\d+\.\d+\.\d+\n$/);
  } finally {
    await remove(fixture.root);
  }
});

test('fails closed when the Node runtime mount overlaps the checkout', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux is required.');
  const runtimeRoot = path.dirname(path.dirname(process.execPath));
  let fixture;
  try {
    fixture = await createFixture({basePath: runtimeRoot});
  } catch {
    return t.skip('The Node runtime directory is not writable for this fixture.');
  }
  try {
    const result = await executeProofCommand(fixture.request);
    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'ISOLATION_UNAVAILABLE');
  } finally {
    await remove(fixture.root);
  }
});

test('returns COMMAND_TIMEOUT for a real isolated process tree timeout', async (t) => {
  if (process.platform !== 'linux') t.skip('Linux is required.');
  const fixture = await createFixture();
  const command = {
    executable: process.execPath,
    args: ['-e', "const {spawn} = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {stdio: 'ignore'}); setTimeout(() => {}, 10000);"],
    cwd: '.',
    timeoutSeconds: 1,
  };
  try {
    const result = await executeProofCommand({...fixture.request, approvedCommand: command, command});
    if (result.code === 'ISOLATION_UNAVAILABLE') {
      return t.skip('The host cannot establish Bubblewrap namespaces.');
    }
    assert.equal(result.kind, 'command-outcome');
    assert.equal(result.code, 'COMMAND_TIMEOUT');
    assert.equal(result.execution.state, 'TIMED_OUT');
    assert.equal(result.execution.exitCode, null);
    assert.equal(result.sourceIntegrity, 'UNCHANGED');
  } finally {
    await remove(fixture.root);
  }
});

function adapter(execute) {
  return {check: async () => ({available: true}), execute};
}

async function assertUnsupportedSubtype(configure, subtype) {
  const fixture = await createFixture();
  try {
    await configure(fixture.root);
    await assertUnsupportedSubtypeAtPath(fixture.root, subtype);
  } finally {
    await remove(fixture.root);
  }
}

async function assertUnsupportedObservedPath(entryPath, subtype) {
  const fixture = await createFixture();
  try {
    await assertUnsupportedSubtypeAtPath(fixture.root, subtype, [entryPath]);
  } finally {
    await remove(fixture.root);
  }
}

async function assertMalformedGitTree(treeOutput, subtype) {
  const fixture = await createFixture();
  const wrapper = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ticket-git-wrapper-')), 'git-wrapper.mjs');
  try {
    const bytes = [...treeOutput];
    await fs.writeFile(wrapper, `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('ls-tree')) {
  process.stdout.write(Buffer.from(${JSON.stringify(bytes)}));
  process.exit(0);
}
const result = spawnSync('git', args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
`);
    await fs.chmod(wrapper, 0o755);
    const command = {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: '.',
      timeoutSeconds: 2,
    };
    const result = await executeProofCommand({
      proofSubject: {
        ...fixture.request.proofSubject,
        trackedPatch: Buffer.alloc(0),
        manifest: [],
        untrackedFiles: [],
        untrackedPaths: [],
        gitStatus: '',
      },
      approvedCommand: command,
      command,
    }, {
      gitBinary: wrapper,
      isolation: adapter(async () => ({state: 'EXITED', exitCode: 0, signal: null})),
    });
    assert.equal(result.kind, 'run-error');
    assert.equal(result.code, 'UNSUPPORTED_CHECKOUT_SHAPE');
    assert.deepEqual(result.details, {subtype});
  } finally {
    await remove(path.dirname(wrapper));
    await remove(fixture.root);
  }
}

async function assertUnsupportedSubtypeAtPath(root, subtype, untrackedPaths = []) {
  const command = {
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: '.',
    timeoutSeconds: 2,
  };
  const proofSubject = {
    sourcePath: root,
    commitSha: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    trackedPatch: Buffer.alloc(0),
    manifest: [],
    untrackedFiles: [],
    untrackedPaths,
    gitStatus: await git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
  let checked = 0;
  const result = await executeProofCommand({proofSubject, approvedCommand: command, command}, {
    isolation: {
      check: async () => {
        checked += 1;
        return {available: true};
      },
      execute: async () => ({state: 'EXITED', exitCode: 0, signal: null}),
    },
  });
  assert.equal(result.kind, 'run-error');
  assert.equal(result.code, 'UNSUPPORTED_CHECKOUT_SHAPE');
  assert.deepEqual(result.details, {subtype});
  assert.equal(checked, 0);
}

async function snapshotHash(root) {
  const entries = [];
  async function visit(current, relative) {
    for (const name of (await fs.readdir(current)).sort()) {
      const next = path.join(current, name);
      const nextRelative = relative ? `${relative}/${name}` : name;
      const stat = await fs.stat(next);
      if (stat.isDirectory()) {
        await visit(next, nextRelative);
      } else {
        entries.push({path: nextRelative, mode: stat.mode & 0o777, sha256: await sha256File(next)});
      }
    }
  }
  await visit(root, '');
  return sha256(JSON.stringify(entries));
}

async function createFixture({dirty = false, binary = false, basePath = os.tmpdir()} = {}) {
  const root = await fs.mkdtemp(path.join(basePath, 'prove-ticket-test-'));
  await fs.mkdir(path.join(root, 'src'), {recursive: true});
  await fs.writeFile(path.join(root, 'src/message.txt'), 'clean\n');
  if (binary) await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0, 1, 2, 3]));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Proof Fixture']);
  await git(root, ['config', 'user.email', 'proof@example.invalid']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'fixture']);

  const commitSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const cleanContent = dirty ? 'dirty\n' : 'clean\n';
  if (dirty) {
    await fs.writeFile(path.join(root, 'src/message.txt'), cleanContent);
    await fs.mkdir(path.join(root, 'notes'), {recursive: true});
    await fs.writeFile(path.join(root, 'notes/safe.txt'), 'safe\n');
  }
  const trackedPatch = await gitBuffer(root, ['diff', '--binary', '--full-index', 'HEAD', '--']);
  if (binary) await fs.writeFile(path.join(root, 'src/blob.bin'), Buffer.from([0, 255, 1, 254, 2]));
  const finalTrackedPatch = await gitBuffer(root, ['diff', '--binary', '--full-index', 'HEAD', '--']);
  const finalTrackedManifest = await manifestFor(root, ['src/message.txt', ...(binary ? ['src/blob.bin'] : [])]);
  const untrackedFiles = dirty ? [{path: 'notes/safe.txt', mode: 0o644, content: 'safe\n'}] : [];
  const manifest = dirty
    ? [...finalTrackedManifest, {path: 'notes/safe.txt', mode: 0o644, sha256: sha256(Buffer.from('safe\n'))}]
    : finalTrackedManifest;
  const gitStatus = (await git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const command = {executable: process.execPath, args: ['-e', 'process.stdout.write("pass\\n")'], cwd: '.', timeoutSeconds: 2};
  return {
    root,
    request: {
      proofSubject: {sourcePath: root, commitSha, trackedPatch: binary ? finalTrackedPatch : trackedPatch, manifest, untrackedFiles, gitStatus},
      approvedCommand: command,
      command,
      redactionValues: ['top-secret'],
    },
  };
}

async function manifestFor(root, paths) {
  return Promise.all(paths.map(async (relative) => {
    const stat = await fs.stat(path.join(root, relative));
    return {path: relative, mode: stat.mode & 0o777, sha256: await sha256File(path.join(root, relative))};
  }));
}

async function git(root, args) {
  const result = await execFileAsync('git', ['-C', root, ...args], {encoding: 'utf8'});
  return result.stdout;
}

async function gitBuffer(root, args) {
  const result = await execFileAsync('git', ['-C', root, ...args], {encoding: 'buffer'});
  return result.stdout;
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function remove(root) {
  await fs.rm(root, {recursive: true, force: true});
}
