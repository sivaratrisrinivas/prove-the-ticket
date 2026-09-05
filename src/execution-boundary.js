import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MAX_STREAM_BYTES = 64 * 1024;
const STREAM_HALF_BYTES = 32 * 1024;
const MAX_RENDERED_EXCERPT_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const LOCAL_CHECKOUT = '<local-checkout>';
const TEMPORARY_SNAPSHOT = '<temporary-snapshot>';
const CLEANUP_NOT_REQUIRED = Object.freeze({state: 'NOT_REQUIRED'});

const INSTALL_COMMANDS = new Map([
  ['npm', new Set(['install', 'i', 'ci', 'update', 'uninstall'])],
  ['pnpm', new Set(['add', 'install', 'update', 'remove', 'import'])],
  ['yarn', new Set(['add', 'install', 'remove', 'up'])],
  ['bun', new Set(['add', 'install', 'remove', 'update'])],
]);

const WARNING_ORDER = new Map([
  ['BINARY_OUTPUT_OMITTED', 0],
  ['OUTPUT_TRUNCATED', 1],
  ['VALUE_REDACTED', 2],
]);

/**
 * @typedef {{path: string, mode: number|string, sha256: string}} ManifestEntry
 * @typedef {{path: string, mode: number|string, content: Uint8Array|string, sha256?: string}} UntrackedFile
 * @typedef {{sourcePath: string, targetPath?: string, requiredPaths?: string[]}} DependencyTree
 * @typedef {{sourcePath: string, commitSha: string, trackedPatch?: Uint8Array|string, manifest: ManifestEntry[], untrackedFiles?: UntrackedFile[], untrackedPaths?: string[], dependencyTree?: DependencyTree, gitStatus: string}} ProofSubject
 * @typedef {{executable: string, args?: string[], cwd?: string, timeoutSeconds?: number, environmentPolicy?: {variables?: Record<string, string>, inherit?: string[]}}} ApprovedCommand
 * @typedef {{proofSubject: ProofSubject, approvedCommand: ApprovedCommand, command?: ApprovedCommand, redactionValues?: string[]}} ExecutionRequest
 * @typedef {{state: 'EXITED'|'SIGNALED'|'TIMED_OUT', exitCode: number|null, signal: string|null, stdout?: Uint8Array|string, stderr?: Uint8Array|string, durationMs?: number}} ProcessOutcome
 * @typedef {{check: (context: {platform: string}) => Promise<{available: true}|{available: false, reason?: string}>, execute: (context: {snapshotPath: string, scratchPath: string, dependencyTree: DependencyTree|null, command: ApprovedCommand, internalCwd: string, environment: Record<string, string>, sourcePath: string}) => Promise<ProcessOutcome>}} IsolationAdapter
 * @typedef {{isolation?: IsolationAdapter, platform?: string, now?: () => number, tempRoot?: string, bwrapBinary?: string, gitBinary?: string, tarBinary?: string}} ExecutionOptions
 */

class BoundaryError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Execute exactly one approved command against an isolated reconstruction of a
 * fingerprinted proof subject.
 *
 * @param {ExecutionRequest} request
 * @param {ExecutionOptions} [options]
 */
export async function executeProofCommand(request, options = {}) {
  const runtime = createRuntime(options);
  let workspace = null;
  let outcome;

  try {
    validateRequest(request, runtime.platform);

    const requestedCommand = request.command || request.approvedCommand;
    if (isInstallCommand(requestedCommand)) {
      throw new BoundaryError(
        'INSTALL_COMMAND_REJECTED',
        'Dependency installation commands are not allowed in a proof run.',
      );
    }

    if (request.command && !sameCommand(request.approvedCommand, request.command)) {
      throw new BoundaryError(
        'COMMAND_NOT_APPROVED',
        'The execution command differs from the approved command plan.',
      );
    }

    validateWorkspaceLocation(request.proofSubject.sourcePath, runtime.tempRoot);
    await validateCheckoutShape(request.proofSubject, runtime);
    await validateApprovedUntrackedPaths(request.proofSubject);
    const before = await captureSourceState(request.proofSubject, runtime);
    await assertProofSubjectMatches(request.proofSubject, before, 'SNAPSHOT_MISMATCH');

    const capability = await runtime.isolation.check({platform: runtime.platform});
    if (!capability?.available) {
      throw new BoundaryError(
        'ISOLATION_UNAVAILABLE',
        capability?.reason || 'The host cannot establish the required isolation.',
      );
    }

    workspace = await createWorkspace(runtime.tempRoot);
    workspace.sourcePath = request.proofSubject.sourcePath;
    workspace.dependencyPath = request.proofSubject.dependencyTree?.sourcePath || null;
    await reconstructSnapshot(request.proofSubject, workspace.snapshotPath, runtime);
    await verifySnapshotManifest(workspace.snapshotPath, request.proofSubject.manifest);

    const dependencyTree = request.proofSubject.dependencyTree || null;
    if (dependencyTree) {
      await verifyDependencyTree(dependencyTree);
      await fs.mkdir(resolveInside(workspace.snapshotPath, dependencyTree.targetPath || 'node_modules'), {recursive: true});
    }

    const command = normalizeCommand(requestedCommand);
    const internalCwd = resolveInside(workspace.snapshotPath, command.cwd);
    await ensureDirectory(internalCwd);
    const environment = buildEnvironment(command, workspace.scratchPath);
    const startedAt = runtime.now();
    let processOutcome;
    let processError = null;
    try {
      processOutcome = await runtime.isolation.execute({
        snapshotPath: workspace.snapshotPath,
        scratchPath: workspace.scratchPath,
        dependencyTree,
        command,
        internalCwd,
        environment,
        sourcePath: request.proofSubject.sourcePath,
      });
    } catch (error) {
      processError = error;
    }
    const endedAt = runtime.now();

    let after;
    try {
      after = await captureSourceState(request.proofSubject, runtime);
    } catch (error) {
      if (error instanceof BoundaryError) {
        throw new BoundaryError('SOURCE_CHANGED', 'The source checkout or dependency tree changed during execution.');
      }
      throw error;
    }
    if (!sameSourceState(before, after)) {
      throw new BoundaryError(
        'SOURCE_CHANGED',
        'The source checkout or dependency tree changed during execution.',
      );
    }
    if (processError) throw processError;
    validateProcessOutcome(processOutcome);

    const output = formatProcessOutput(processOutcome, request, workspace);
    outcome = {
      kind: 'command-outcome',
      ...(processOutcome.state === 'TIMED_OUT' ? {code: 'COMMAND_TIMEOUT'} : {}),
      command: publicCommand(command, workspace),
      execution: {
        state: processOutcome.state,
        exitCode: processOutcome.exitCode,
        signal: processOutcome.signal,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: processOutcome.durationMs ?? Math.max(0, endedAt - startedAt),
        networkPolicy: 'DENIED',
      },
      output,
      warnings: output.warnings,
      sourceIntegrity: 'UNCHANGED',
      cleanup: CLEANUP_NOT_REQUIRED,
    };
  } catch (error) {
    outcome = makeErrorResult(error, request, workspace);
  }

  if (workspace) {
    try {
      await fs.rm(workspace.rootPath, {recursive: true, force: true});
      outcome.cleanup = {state: 'CLEANED'};
    } catch (error) {
      outcome.cleanup = {
        state: 'FAILED',
        code: 'INTERNAL_EXECUTION_ERROR',
        message: sanitizeText(error instanceof Error ? error.message : String(error), workspace),
      };
    }
  }

  return outcome;
}

/** @param {ExecutionOptions} options */
function createRuntime(options) {
  const runtime = {
    platform: options.platform || process.platform,
    now: options.now || (() => Date.now()),
    tempRoot: options.tempRoot || os.tmpdir(),
    bwrapBinary: options.bwrapBinary || 'bwrap',
    gitBinary: options.gitBinary || 'git',
    tarBinary: options.tarBinary || 'tar',
    isolation: options.isolation,
  };
  runtime.isolation ||= createBubblewrapIsolation(runtime);
  return runtime;
}

/** @param {ExecutionOptions} options */
export function createExecutionBoundary(options = {}) {
  return {
    execute(request) {
      return executeProofCommand(request, options);
    },
  };
}

/** @param {ExecutionRequest} request @param {string} platform */
function validateRequest(request, platform) {
  if (!request || typeof request !== 'object') {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'The execution request is not an object.');
  }
  if (platform !== 'linux') {
    throw new BoundaryError('UNSUPPORTED_PLATFORM', 'Proof execution is supported only on Linux.');
  }
  validateProofSubject(request.proofSubject);
  validateCommand(request.approvedCommand);
  if (request.command) validateCommand(request.command);
}

/** @param {string} sourcePath @param {string} tempRoot */
function validateWorkspaceLocation(sourcePath, tempRoot) {
  if (!path.isAbsolute(tempRoot)) {
    throw new BoundaryError('ISOLATION_UNAVAILABLE', 'The temporary workspace root must be absolute.');
  }
  const relative = path.relative(path.resolve(sourcePath), path.resolve(tempRoot));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new BoundaryError('ISOLATION_UNAVAILABLE', 'The temporary workspace cannot be inside the local checkout.');
  }
}

/** @param {ProofSubject} subject */
function validateProofSubject(subject) {
  if (!subject || typeof subject !== 'object' || !path.isAbsolute(subject.sourcePath)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The proof subject has no absolute local checkout.');
  }
  if (!/^[0-9a-f]{40,64}$/i.test(subject.commitSha)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The proof subject commit is not a full Git object id.');
  }
  if (!Array.isArray(subject.manifest)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The proof subject manifest is missing.');
  }
  if (typeof subject.gitStatus !== 'string') {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The proof subject Git status is missing.');
  }

  const paths = new Set();
  for (const entry of subject.manifest) {
    validateManifestEntry(entry);
    if (paths.has(entry.path)) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'The proof subject manifest contains duplicate paths.');
    }
    paths.add(entry.path);
  }

  const untracked = subject.untrackedFiles || [];
  if (!Array.isArray(untracked)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The approved untracked records are not an array.');
  }
  const untrackedPaths = new Set();
  for (const entry of untracked) {
    validateUntrackedFile(entry);
    if (untrackedPaths.has(entry.path)) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'The approved untracked records contain duplicate paths.');
    }
    untrackedPaths.add(entry.path);
  }
  const observedUntrackedPaths = subject.untrackedPaths || [...untrackedPaths];
  if (!Array.isArray(observedUntrackedPaths)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The observed untracked paths are not an array.');
  }
  const observedPaths = new Set();
  for (const entryPath of observedUntrackedPaths) {
    validateRelativePath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (observedPaths.has(entryPath)) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'The observed untracked paths contain duplicates.');
    }
    observedPaths.add(entryPath);
  }
  for (const entryPath of untrackedPaths) {
    if (!observedPaths.has(entryPath)) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'An included untracked path was not observed.');
    }
  }

  if (subject.dependencyTree) {
    if (!subject.dependencyTree.sourcePath || !path.isAbsolute(subject.dependencyTree.sourcePath)) {
      throw new BoundaryError('DEPENDENCIES_UNAVAILABLE', 'The dependency tree has no absolute source path.');
    }
    validateRelativePath(subject.dependencyTree.targetPath || 'node_modules', 'SNAPSHOT_MISMATCH');
    for (const requiredPath of subject.dependencyTree.requiredPaths || []) {
      validateRelativePath(requiredPath, 'DEPENDENCIES_UNAVAILABLE');
    }
  }
}

/** @param {ManifestEntry} entry */
function validateManifestEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'A manifest entry is not an object.');
  }
  validateRelativePath(entry.path, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
  normalizeMode(entry.mode, 'SNAPSHOT_MISMATCH');
  if (!/^[0-9a-f]{64}$/i.test(entry.sha256)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', `The manifest hash for ${entry.path} is invalid.`);
  }
}

/** @param {UntrackedFile} entry */
function validateUntrackedFile(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'An approved untracked record is not an object.');
  }
  validateRelativePath(entry.path, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
  normalizeMode(entry.mode, 'SNAPSHOT_MISMATCH');
  if (!('content' in entry)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', `The approved untracked record for ${entry.path} has no content.`);
  }
  const content = toBuffer(entry.content);
  if (entry.sha256 && entry.sha256 !== hashBuffer(content)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', `The approved untracked hash for ${entry.path} is stale.`);
  }
}

/** @param {ApprovedCommand} command */
function validateCommand(command) {
  if (!command || typeof command !== 'object' || typeof command.executable !== 'string' || command.executable.length === 0) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The approved command has no executable.');
  }
  if (command.executable.includes('\0') || command.executable.includes('\n')) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The executable contains invalid characters.');
  }
  const args = command.args || [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The command arguments are invalid.');
  }
  const cwd = command.cwd || '.';
  validateRelativePath(cwd, 'COMMAND_NOT_APPROVED');
  const timeoutSeconds = command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The command timeout must be an integer from 1 through 3,600 seconds.');
  }
  const environmentPolicy = command.environmentPolicy || {};
  if (environmentPolicy.variables !== undefined && (typeof environmentPolicy.variables !== 'object' || Array.isArray(environmentPolicy.variables))) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The command environment policy is invalid.');
  }
  if (environmentPolicy.inherit !== undefined && (!Array.isArray(environmentPolicy.inherit) || environmentPolicy.inherit.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The inherited environment policy is invalid.');
  }
  for (const [name, value] of Object.entries(environmentPolicy.variables || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new BoundaryError('COMMAND_NOT_APPROVED', 'The explicit environment policy is invalid.');
    }
  }
}

/** @param {ApprovedCommand} command */
function normalizeCommand(command) {
  return {
    executable: command.executable,
    args: [...(command.args || [])],
    cwd: normalizeRelativePath(command.cwd || '.'),
    timeoutSeconds: command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    environmentPolicy: {
      variables: Object.fromEntries(Object.entries(command.environmentPolicy?.variables || {}).sort(([a], [b]) => compareStrings(a, b))),
      inherit: [...(command.environmentPolicy?.inherit || [])].sort(),
    },
  };
}

/** @param {ApprovedCommand} left @param {ApprovedCommand} right */
function sameCommand(left, right) {
  return JSON.stringify(normalizeCommand(left)) === JSON.stringify(normalizeCommand(right));
}

/** @param {ApprovedCommand} command */
function isInstallCommand(command) {
  const executable = path.basename(command.executable).toLowerCase();
  if (['npx', 'pnpx', 'bunx'].includes(executable)) return true;
  const args = command.args || [];
  if (executable === 'yarn' && args.some((arg, index) => index > 0 && arg.toLowerCase() === 'dlx')) return true;
  const actions = INSTALL_COMMANDS.get(executable);
  return Boolean(actions && args.some((arg) => actions.has(arg.toLowerCase())));
}

/** @param {string} relative @param {string} code @param {boolean} [ordinaryOnly] */
function validateRelativePath(relative, code, ordinaryOnly = false) {
  if (typeof relative !== 'string' || relative.length === 0 || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0')) {
    throw new BoundaryError(code, 'A repository-relative path is required.');
  }
  if (/[\u0000-\u001f\u007f]/.test(relative)) {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a control-character path.', {subtype: 'CONTROL_CHARACTER_PATH'});
  }
  const parts = relative.split('/');
  if (relative !== '.' && (parts.some((part) => part === '' || part === '.' || part === '..') || relative.includes('\\'))) {
    throw new BoundaryError(ordinaryOnly ? 'UNSUPPORTED_CHECKOUT_SHAPE' : code, 'The checkout contains a traversal path.', {subtype: 'PATH_TRAVERSAL'});
  }
  if (ordinaryOnly && relative.startsWith('.git/')) {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'Git metadata cannot be part of the proof subject.');
  }
}

/** @param {string} relative */
function normalizeRelativePath(relative) {
  if (relative === '.') return '.';
  return relative.replace(/\/+$/, '');
}

/** @param {number|string} mode @param {string} code */
function normalizeMode(mode, code) {
  const numeric = typeof mode === 'string' ? Number.parseInt(mode, 8) : mode;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0o777777) {
    throw new BoundaryError(code, 'A manifest mode is invalid.');
  }
  return numeric >= 0o100000 ? numeric & 0o777 : numeric;
}

/** @param {string} root @param {string} relative */
function resolveInside(root, relative) {
  const resolved = path.resolve(root, ...relative.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'A path escaped the temporary snapshot.');
  }
  return resolved;
}

/** @param {string} tempRoot */
async function createWorkspace(tempRoot) {
  const rootPath = await fs.mkdtemp(path.join(tempRoot, 'prove-the-ticket-'));
  try {
    const snapshotPath = path.join(rootPath, 'snapshot');
    const scratchPath = path.join(rootPath, 'scratch');
    await fs.mkdir(snapshotPath, {mode: 0o700});
    await fs.mkdir(scratchPath, {mode: 0o700});
    return {rootPath, snapshotPath, scratchPath};
  } catch (error) {
    await fs.rm(rootPath, {recursive: true, force: true}).catch(() => {});
    throw error;
  }
}

/** @param {ProofSubject} subject @param {string} snapshotPath @param {ReturnType<typeof createRuntime>} runtime */
async function reconstructSnapshot(subject, snapshotPath, runtime) {
  const tree = await git(runtime, subject.sourcePath, ['ls-tree', '-r', '-z', '--full-tree', subject.commitSha]);
  await validateCommittedTree(tree, subject.sourcePath, runtime);
  await archiveCommit(subject.sourcePath, subject.commitSha, snapshotPath, runtime);

  const patch = toBuffer(subject.trackedPatch || '');
  if (patch.length > 0) {
    const applied = await runFile(runtime.gitBinary, ['apply', '--binary', '--whitespace=nowarn'], {
      cwd: snapshotPath,
      input: patch,
    });
    if (applied.code !== 0) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'The tracked patch could not be applied to the committed tree.');
    }
  }

  for (const entry of subject.untrackedFiles || []) {
    const destination = resolveInside(snapshotPath, entry.path);
    try {
      await fs.lstat(destination);
      throw new BoundaryError('SNAPSHOT_MISMATCH', `The untracked path ${entry.path} already exists in the committed tree.`);
    } catch (error) {
      if (error instanceof BoundaryError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, toBuffer(entry.content), {mode: normalizeMode(entry.mode, 'SNAPSHOT_MISMATCH')});
    await fs.chmod(destination, normalizeMode(entry.mode, 'SNAPSHOT_MISMATCH'));
  }
}

/** @param {ProofSubject} subject @param {ReturnType<typeof createRuntime>} runtime */
async function validateCheckoutShape(subject, runtime) {
  const tree = await git(runtime, subject.sourcePath, ['ls-tree', '-r', '-z', '--full-tree', subject.commitSha]);
  await validateCommittedTree(tree, subject.sourcePath, runtime);
}

/** @param {ProofSubject} subject */
async function validateApprovedUntrackedPaths(subject) {
  const paths = subject.untrackedPaths || (subject.untrackedFiles || []).map(({path: entryPath}) => entryPath);
  for (const entryPath of paths) {
    const stat = await fs.lstat(resolveInside(subject.sourcePath, entryPath)).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains an untracked symlink.', {subtype: 'SYMLINK'});
    }
    if (!stat) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', 'An approved untracked path is unavailable.');
    }
    if (!stat.isFile()) {
      throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains an untracked special file.', {subtype: 'SPECIAL_FILE'});
    }
  }
}

/** @param {ProcessOutcome} outcome */
function validateProcessOutcome(outcome) {
  if (!outcome || !['EXITED', 'SIGNALED', 'TIMED_OUT'].includes(outcome.state)) {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'The isolation adapter returned an invalid process outcome.');
  }
  if (outcome.state === 'EXITED' && (!Number.isInteger(outcome.exitCode) || outcome.signal !== null)) {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'The exit outcome is malformed.');
  }
  if (outcome.state === 'SIGNALED' && (outcome.exitCode !== null || typeof outcome.signal !== 'string')) {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'The signal outcome is malformed.');
  }
  if (outcome.state === 'TIMED_OUT' && (outcome.exitCode !== null || typeof outcome.signal !== 'string')) {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'The timeout outcome is malformed.');
  }
}

/** @param {Buffer} treeOutput @param {string} sourcePath @param {ReturnType<typeof createRuntime>} runtime */
async function validateCommittedTree(treeOutput, sourcePath, runtime) {
  const entries = splitNul(treeOutput);
  for (const rawEntry of entries) {
    const tab = rawEntry.indexOf(9);
    if (tab < 0) throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git tree entry is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    const header = decodeUtf8(rawEntry.subarray(0, tab));
    let entryPath;
    try {
      entryPath = decodeUtf8(rawEntry.subarray(tab + 1));
    } catch {
      throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a non-UTF-8 path.', {subtype: 'NON_UTF8_PATH'});
    }
    const [mode, type] = header.split(' ');
    validateRelativePath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      const subtype = type === 'commit' ? 'SUBMODULE' : mode === '120000' ? 'SYMLINK' : type === 'blob' ? 'SPECIAL_FILE' : 'UNKNOWN_ENTRY_TYPE';
      throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', `The checkout contains an unsupported ${subtype} entry.`, {subtype});
    }
    const attr = await git(runtime, sourcePath, ['check-attr', 'filter', '--cached', '--', entryPath]);
    if (decodeUtf8(attr).trim().endsWith(': lfs')) {
      throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a Git LFS-managed path.', {subtype: 'GIT_LFS'});
    }
  }

  const sparse = await runFile(runtime.gitBinary, ['-C', sourcePath, 'config', '--bool', 'core.sparseCheckout']);
  if (sparse.code === 0 && decodeUtf8(sparse.stdout).trim() === 'true') {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout uses sparse checkout.', {subtype: 'SPARSE_CHECKOUT'});
  }

  const gitDirectory = path.resolve(sourcePath, decodeUtf8(await git(runtime, sourcePath, ['rev-parse', '--git-dir'])).trim());
  const commonDirectory = path.resolve(sourcePath, decodeUtf8(await git(runtime, sourcePath, ['rev-parse', '--git-common-dir'])).trim());
  if (gitDirectory !== commonDirectory) {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout is a linked worktree.', {subtype: 'LINKED_WORKTREE'});
  }
}

/** @param {string} sourcePath @param {string} commitSha @param {string} snapshotPath @param {ReturnType<typeof createRuntime>} runtime */
async function archiveCommit(sourcePath, commitSha, snapshotPath, runtime) {
  const archive = spawn(runtime.gitBinary, ['-C', sourcePath, 'archive', '--format=tar', commitSha], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extract = spawn(runtime.tarBinary, ['-xf', '-', '-C', snapshotPath], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const archiveError = collectBytes(archive.stderr);
  const extractError = collectBytes(extract.stderr);
  archive.stdout.pipe(extract.stdin);

  const [archiveStatus, extractStatus] = await Promise.all([
    waitForChild(archive),
    waitForChild(extract),
  ]);
  if (archiveStatus.code !== 0 || extractStatus.code !== 0) {
    const detail = decodeUtf8(Buffer.concat([await archiveError, await extractError])).trim();
    throw new BoundaryError('SNAPSHOT_MISMATCH', detail || 'The committed tree could not be reconstructed.');
  }
}

/** @param {string} command @param {string[]} args @param {{cwd?: string, input?: Uint8Array}} [options] */
async function runFile(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = collectBytes(child.stdout);
  const stderr = collectBytes(child.stderr);
  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();
  const status = await new Promise((resolve) => {
    child.once('error', (error) => resolve({code: 1, signal: null, error}));
    child.once('close', (code, signal) => resolve({code, signal, error: null}));
  });
  return {
    code: status.code ?? 1,
    signal: status.signal,
    stdout: await stdout,
    stderr: await stderr,
  };
}

/** @param {ReturnType<typeof createRuntime>} runtime @param {string} cwd @param {string[]} args */
async function git(runtime, cwd, args) {
  const result = await runFile(runtime.gitBinary, ['-C', cwd, ...args]);
  if (result.code !== 0) {
    throw new BoundaryError('INTERNAL_EXECUTION_ERROR', `Git metadata inspection failed for ${LOCAL_CHECKOUT}.`);
  }
  return result.stdout;
}

/** @param {ProofSubject} subject @param {ReturnType<typeof createRuntime>} runtime */
async function captureSourceState(subject, runtime) {
  const sourceManifest = await readExpectedManifest(subject.sourcePath, subject.manifest);
  const patch = await git(runtime, subject.sourcePath, ['diff', '--binary', '--full-index', 'HEAD', '--']);
  const status = decodeUtf8(await git(runtime, subject.sourcePath, ['status', '--porcelain=v1', '--untracked-files=all']));
  const untrackedPaths = decodePathList(await git(runtime, subject.sourcePath, ['ls-files', '--others', '--exclude-standard', '-z']));
  const dependencyDigest = subject.dependencyTree ? await dependencyState(subject.dependencyTree) : null;
  return {
    commitSha: decodeUtf8(await git(runtime, subject.sourcePath, ['rev-parse', 'HEAD'])).trim(),
    trackedPatchSha256: hashBuffer(patch),
    status,
    untrackedPaths,
    manifestDigest: hashJson(sourceManifest),
    dependencyDigest,
  };
}

/** @param {string} sourcePath @param {ManifestEntry[]} expected */
async function readExpectedManifest(sourcePath, expected) {
  const actual = [];
  for (const entry of expected) {
    const absolute = resolveInside(sourcePath, entry.path);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new BoundaryError('SNAPSHOT_MISMATCH', `The source manifest path ${entry.path} is unavailable.`);
    }
    actual.push({path: entry.path, mode: stat.mode & 0o777, sha256: await hashFile(absolute)});
  }
  return actual.sort(compareManifestEntries);
}

/** @param {string} snapshotPath @param {ManifestEntry[]} expected */
async function verifySnapshotManifest(snapshotPath, expected) {
  const actualTree = await walkTree(snapshotPath);
  if (actualTree.some((entry) => entry.kind !== 'file')) {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The reconstructed snapshot contains a non-regular file.', {subtype: 'SPECIAL_FILE'});
  }
  const actual = actualTree.map(({path: entryPath, mode, sha256}) => ({path: entryPath, mode, sha256})).sort(compareManifestEntries);
  const normalizedExpected = expected.map((entry) => ({
    path: entry.path,
    mode: normalizeMode(entry.mode, 'SNAPSHOT_MISMATCH'),
    sha256: entry.sha256.toLowerCase(),
  })).sort(compareManifestEntries);
  if (hashJson(actual) !== hashJson(normalizedExpected)) {
    throw new BoundaryError('SNAPSHOT_MISMATCH', 'The reconstructed manifest differs from the proof subject.');
  }
}

/** @param {DependencyTree} dependencyTree */
async function verifyDependencyTree(dependencyTree) {
  const stat = await fs.stat(dependencyTree.sourcePath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new BoundaryError('DEPENDENCIES_UNAVAILABLE', 'The existing dependency tree is unavailable.');
  }
  for (const requiredPath of dependencyTree.requiredPaths || []) {
    const required = resolveInside(dependencyTree.sourcePath, requiredPath);
    if (!(await fs.stat(required).catch(() => null))) {
      throw new BoundaryError('DEPENDENCIES_UNAVAILABLE', `A required dependency path is unavailable.`);
    }
  }
}

/** @param {string} directory */
async function ensureDirectory(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new BoundaryError('COMMAND_NOT_APPROVED', 'The approved working directory is unavailable.');
  }
}

/** @param {DependencyTree} dependencyTree */
async function dependencyState(dependencyTree) {
  await verifyDependencyTree(dependencyTree);
  return hashJson(await walkTree(dependencyTree.sourcePath));
}

/** @param {string} root */
async function walkTree(root) {
  const entries = [];
  async function visit(current, relative) {
    const names = (await fs.readdir(current)).sort();
    for (const name of names) {
      const next = path.join(current, name);
      const nextRelative = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink()) {
        entries.push({path: nextRelative, kind: 'symlink', target: await fs.readlink(next)});
      } else if (stat.isDirectory()) {
        await visit(next, nextRelative);
      } else if (stat.isFile()) {
        entries.push({path: nextRelative, kind: 'file', mode: stat.mode & 0o777, sha256: await hashFile(next)});
      } else {
        throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The dependency tree contains an unsupported entry.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
      }
    }
  }
  await visit(root, '');
  return entries;
}

/** @param {ReturnType<typeof createRuntime>} runtime */
function createBubblewrapIsolation(runtime) {
  return {
    async check({platform}) {
      if (platform !== 'linux') return {available: false, reason: 'The host is not Linux.'};
      const result = await runFile(runtime.bwrapBinary, [
        '--die-with-parent',
        '--unshare-net',
        '--unshare-pid',
        '--ro-bind', '/', '/',
        '--proc', '/proc',
        '--dev', '/dev',
        '--clearenv',
        '--', '/usr/bin/true',
      ]);
      return result.code === 0
        ? {available: true}
        : {available: false, reason: 'Bubblewrap cannot establish the required network and process namespaces.'};
    },
    async execute(context) {
      const target = resolveInside(context.snapshotPath, context.command.cwd);
      const args = [
        '--die-with-parent',
        '--unshare-net',
        '--unshare-pid',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp',
        '--proc', '/proc',
        '--dev', '/dev',
        '--ro-bind', context.snapshotPath, context.snapshotPath,
        '--bind', context.scratchPath, context.scratchPath,
        '--clearenv',
        '--chdir', target,
        '--setenv', 'PROVE_THE_TICKET_SCRATCH_DIR', context.scratchPath,
      ];
      if (context.dependencyTree) {
        const dependencyTarget = resolveInside(context.snapshotPath, context.dependencyTree.targetPath || 'node_modules');
        args.push('--ro-bind', context.dependencyTree.sourcePath, dependencyTarget);
      }
      for (const [name, value] of Object.entries(context.environment)) {
        args.push('--setenv', name, value);
      }
      args.push('--', context.command.executable, ...context.command.args);
      return runBubblewrapProcess(runtime.bwrapBinary, args, context.command.timeoutSeconds, context.environment);
    },
  };
}

/** @param {string} executable @param {string[]} args @param {number} timeoutSeconds @param {Record<string, string>} environment */
async function runBubblewrapProcess(executable, args, timeoutSeconds, environment) {
  const startedAt = Date.now();
  const child = spawn(executable, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  const stdout = collectBoundedBytes(child.stdout);
  const stderr = collectBoundedBytes(child.stderr);
  let timedOut = false;
  let timer;
  const close = waitForChild(child);
  timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, timeoutSeconds * 1000);
  const status = await close;
  clearTimeout(timer);
  const stderrCapture = await stderr;
  if (!timedOut && status.code !== 0 && /^bwrap:/.test(stderrCapture.retained.toString('utf8'))) {
    throw new BoundaryError('ISOLATION_UNAVAILABLE', 'Bubblewrap could not create the execution sandbox.');
  }
  return {
    state: timedOut ? 'TIMED_OUT' : status.signal ? 'SIGNALED' : 'EXITED',
    exitCode: timedOut ? null : status.code,
    signal: timedOut ? 'SIGKILL' : status.signal,
    stdout: await stdout,
    stderr: stderrCapture,
    durationMs: Date.now() - startedAt,
  };
}

/** @param {number|undefined} pid */
function killProcessTree(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}

/** @param {import('node:child_process').ChildProcess} child */
function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
}

/** @param {import('node:stream').Readable|null} stream */
function collectBytes(stream) {
  if (!stream) return Promise.resolve(Buffer.alloc(0));
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** @param {import('node:stream').Readable|null} stream */
function collectBoundedBytes(stream) {
  if (!stream) return Promise.resolve(captureBuffer(Buffer.alloc(0)));
  const head = [];
  let headBytes = 0;
  const prefix = [];
  let prefixBytes = 0;
  let tail = Buffer.alloc(0);
  let byteCount = 0;
  let binary = false;
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      byteCount += bytes.length;
      digest.update(bytes);
      if (headBytes < STREAM_HALF_BYTES) {
        const headPart = bytes.subarray(0, Math.min(bytes.length, STREAM_HALF_BYTES - headBytes));
        head.push(headPart);
        headBytes += headPart.length;
      }
      if (prefixBytes < MAX_STREAM_BYTES) {
        const prefixPart = bytes.subarray(0, Math.min(bytes.length, MAX_STREAM_BYTES - prefixBytes));
        prefix.push(prefixPart);
        prefixBytes += prefixPart.length;
      }
      tail = Buffer.concat([tail, bytes]).subarray(-STREAM_HALF_BYTES);
      if (!binary) {
        if (bytes.includes(0)) binary = true;
        else {
          try {
            decoder.decode(bytes, {stream: true});
          } catch {
            binary = true;
          }
        }
      }
    });
    stream.once('error', reject);
    stream.once('end', () => {
      if (!binary) {
        try {
          decoder.decode();
        } catch {
          binary = true;
        }
      }
      const retained = byteCount > MAX_STREAM_BYTES
        ? Buffer.concat([Buffer.concat(head), tail])
        : Buffer.concat(prefix);
      resolve({
        kind: 'bounded-capture',
        retained,
        byteCount,
        sha256: digest.digest('hex'),
        truncated: byteCount > MAX_STREAM_BYTES,
        binary,
      });
    });
  });
}

/** @param {Buffer} value */
function captureBuffer(value) {
  const bounded = boundedBytes(value);
  return {
    kind: 'bounded-capture',
    retained: bounded.retained,
    byteCount: bounded.byteCount,
    sha256: hashBuffer(value),
    truncated: bounded.truncated,
    binary: isBinary(value),
  };
}

/** @param {ApprovedCommand} command @param {string} scratchPath */
function buildEnvironment(command, scratchPath) {
  const environment = {};
  for (const name of command.environmentPolicy.inherit) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  environment.HOME = scratchPath;
  environment.TMPDIR = '/tmp';
  for (const [name, value] of Object.entries(command.environmentPolicy.variables)) {
    environment[name] = value;
  }
  return environment;
}

/** @param {ProcessOutcome} processOutcome @param {ExecutionRequest} request @param {{rootPath: string, snapshotPath: string, scratchPath: string}} workspace */
function formatProcessOutput(processOutcome, request, workspace) {
  const redactionValues = collectRedactionValues(request);
  const streams = {};
  const warnings = [];
  for (const [name, value] of [['stdout', processOutcome.stdout || Buffer.alloc(0)], ['stderr', processOutcome.stderr || Buffer.alloc(0)]]) {
    const formatted = formatStream(value, redactionValues, workspace, name);
    streams[name] = formatted.output;
    warnings.push(...formatted.warnings);
  }
  const orderedWarnings = deduplicateWarnings(warnings);
  return {streams, warnings: orderedWarnings};
}

/** @param {ExecutionRequest} request */
function collectRedactionValues(request) {
  const values = new Set(request.redactionValues || []);
  const command = request.command || request.approvedCommand;
  for (const value of Object.values(command.environmentPolicy?.variables || {})) {
    if (value.length >= 4) values.add(value);
  }
  for (const name of command.environmentPolicy?.inherit || []) {
    if (process.env[name]) values.add(process.env[name]);
  }
  for (const entry of request.proofSubject?.untrackedFiles || []) {
    const bytes = toBuffer(entry.content);
    if (isBinary(bytes)) continue;
    const text = decodeUtf8(bytes);
    if (text) values.add(text);
    for (const line of text.split(/\r?\n/)) {
      if (line) values.add(line);
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/(token|secret|password|credential|private|authorization|api[_-]?key)/i.test(name) && value) values.add(value);
  }
  return [...values].filter((value) => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length || compareStrings(a, b));
}

/** @param {Uint8Array|string} value @param {string[]} redactionValues @param {{rootPath: string, snapshotPath: string, scratchPath: string}} workspace @param {string} stream */
function formatStream(value, redactionValues, workspace, stream) {
  const capture = value?.kind === 'bounded-capture' ? value : captureBuffer(toBuffer(value));
  const retained = capture.retained;
  if (capture.binary) {
    return {
      output: {
        binary: true,
        byteCount: capture.byteCount,
        sha256: capture.sha256,
        excerpt: null,
        truncated: capture.truncated,
      },
      warnings: [
        {code: 'BINARY_OUTPUT_OMITTED', stream},
        ...(capture.truncated ? [{code: 'OUTPUT_TRUNCATED', stream}] : []),
      ],
    };
  }

  let text = retained.toString('utf8');
  text = sanitizeText(text, workspace);
  const masked = maskText(text, redactionValues);
  const excerpt = limitExcerpt(masked.text);
  const warnings = [];
  if (capture.truncated) warnings.push({code: 'OUTPUT_TRUNCATED', stream});
  if (masked.changed) warnings.push({code: 'VALUE_REDACTED', stream});
  return {
    output: {
      binary: false,
      byteCount: capture.byteCount,
      excerpt,
      truncated: capture.truncated,
    },
    warnings,
  };
}

/** @param {Buffer} value */
function boundedBytes(value) {
  if (value.length <= MAX_STREAM_BYTES) {
    return {retained: value, byteCount: value.length, truncated: false};
  }
  return {
    retained: Buffer.concat([value.subarray(0, STREAM_HALF_BYTES), value.subarray(value.length - STREAM_HALF_BYTES)]),
    byteCount: value.length,
    truncated: true,
  };
}

/** @param {Buffer} value */
function isBinary(value) {
  if (value.includes(0)) return true;
  try {
    decodeUtf8(value);
    return false;
  } catch {
    return true;
  }
}

/** @param {string} text @param {string[]} values */
function maskText(text, values) {
  let result = text;
  for (const value of values) result = result.split(value).join('<redacted>');
  result = result
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '<redacted>')
    .replace(/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]+\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, '<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1<redacted>')
    .replace(/((?:token|password|secret|api[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s]+)@/gi, '$1<redacted>:<redacted>@');
  return {text: result, changed: result !== text};
}

/** @param {string} text */
function limitExcerpt(text) {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_RENDERED_EXCERPT_BYTES) return text;
  const marker = Buffer.from('\n<excerpt-omitted>\n');
  const sideBytes = Math.floor((MAX_RENDERED_EXCERPT_BYTES - marker.length) / 2);
  return `${bytes.subarray(0, sideBytes).toString('utf8')}${marker.toString()}${bytes.subarray(-sideBytes).toString('utf8')}`;
}

/** @param {string} text @param {{rootPath: string, snapshotPath: string, scratchPath: string}|null} workspace */
function sanitizeText(text, workspace) {
  if (!workspace) return text;
  let result = text;
  for (const [privatePath, replacement] of [
    [workspace.sourcePath, LOCAL_CHECKOUT],
    [workspace.rootPath, TEMPORARY_SNAPSHOT],
    [workspace.snapshotPath, TEMPORARY_SNAPSHOT],
    [workspace.scratchPath, TEMPORARY_SNAPSHOT],
    [workspace.dependencyPath, LOCAL_CHECKOUT],
  ]) {
    if (privatePath) result = result.split(privatePath).join(replacement);
  }
  return result;
}

/** @param {ApprovedCommand} command @param {{rootPath: string, snapshotPath: string, scratchPath: string}} workspace */
function publicCommand(command, workspace) {
  return JSON.parse(sanitizeText(JSON.stringify(command), workspace));
}

/** @param {unknown} error @param {ExecutionRequest} request @param {{rootPath: string, snapshotPath: string, scratchPath: string}|null} workspace */
function makeErrorResult(error, request, workspace) {
  const boundaryError = error instanceof BoundaryError
    ? error
    : new BoundaryError('INTERNAL_EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
  const privacyContext = workspace || (request?.proofSubject?.sourcePath ? {sourcePath: request.proofSubject.sourcePath} : null);
  return {
    kind: 'run-error',
    code: boundaryError.code,
    message: sanitizeText(boundaryError.message, privacyContext),
    ...(Object.keys(boundaryError.details).length > 0 ? {details: boundaryError.details} : {}),
    overallStatus: null,
    proofSeal: null,
    warnings: [],
    cleanup: CLEANUP_NOT_REQUIRED,
  };
}

/** @param {ProofSubject} subject @param {{commitSha: string, trackedPatchSha256: string, status: string, manifestDigest: string, dependencyDigest: string|null}} state @param {string} mismatchCode */
async function assertProofSubjectMatches(subject, state, mismatchCode) {
  const patchHash = hashBuffer(subject.trackedPatch || '');
  const expectedManifest = subject.manifest.map((entry) => ({
    path: entry.path,
    mode: normalizeMode(entry.mode, mismatchCode),
    sha256: entry.sha256.toLowerCase(),
  })).sort(compareManifestEntries);
  const expectedUntrackedPaths = (subject.untrackedPaths || (subject.untrackedFiles || []).map((entry) => entry.path)).sort();
  if (state.commitSha !== subject.commitSha || state.trackedPatchSha256 !== patchHash || state.manifestDigest !== hashJson(expectedManifest) || state.status !== subject.gitStatus || JSON.stringify(state.untrackedPaths) !== JSON.stringify(expectedUntrackedPaths)) {
    throw new BoundaryError(mismatchCode, 'The source checkout does not match the fingerprinted proof subject.');
  }
}

/** @param {ReturnType<typeof captureSourceState>} before @param {ReturnType<typeof captureSourceState>} after */
function sameSourceState(before, after) {
  return before.commitSha === after.commitSha
    && before.trackedPatchSha256 === after.trackedPatchSha256
    && before.status === after.status
    && JSON.stringify(before.untrackedPaths) === JSON.stringify(after.untrackedPaths)
    && before.manifestDigest === after.manifestDigest
    && before.dependencyDigest === after.dependencyDigest;
}

/** @param {unknown} value */
function toBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new BoundaryError('SNAPSHOT_MISMATCH', 'Binary content must be a string or byte array.');
}

/** @param {string} filePath */
async function hashFile(filePath) {
  return hashBuffer(await fs.readFile(filePath));
}

/** @param {Uint8Array} value */
function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value */
function hashJson(value) {
  return hashBuffer(Buffer.from(canonicalJson(value)));
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'Cannot canonicalize a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new BoundaryError('INTERNAL_EXECUTION_ERROR', 'Cannot canonicalize this value.');
}

/** @param {Buffer} value */
function decodeUtf8(value) {
  return new TextDecoder('utf-8', {fatal: true}).decode(value);
}

/** @param {Buffer} value */
function splitNul(value) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === 0) {
      if (index > start) parts.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== value.length) parts.push(value.subarray(start));
  return parts;
}

/** @param {Buffer} value */
function decodePathList(value) {
  try {
    return splitNul(value).map(decodeUtf8).sort();
  } catch {
    throw new BoundaryError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a non-UTF-8 path.', {subtype: 'NON_UTF8_PATH'});
  }
}

/** @param {ManifestEntry} left @param {ManifestEntry} right */
function compareManifestEntries(left, right) {
  return compareStrings(left.path, right.path);
}

/** @param {string} left @param {string} right */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {{code: string, stream?: string}[]} warnings */
function deduplicateWarnings(warnings) {
  const unique = new Map();
  for (const warning of warnings) unique.set(`${warning.code}:${warning.stream || ''}`, warning);
  return [...unique.values()].sort((left, right) => {
    const codeOrder = (WARNING_ORDER.get(left.code) || 99) - (WARNING_ORDER.get(right.code) || 99);
    return codeOrder || compareStrings(left.stream || '', right.stream || '');
  });
}
