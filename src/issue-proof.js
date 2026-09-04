import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {createExecutionBoundary} from './execution-boundary.js';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = '1.0';
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const LOCAL_CHECKOUT = '<local-checkout>';
const LOCKFILE_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const POLICY_ERROR_CODES = new Set([
  'COMMAND_NOT_APPROVED',
  'DEPENDENCIES_UNAVAILABLE',
  'INSTALL_COMMAND_REJECTED',
]);

/**
 * @typedef {{path: string, mode: number, sha256: string}} ManifestEntry
 * @typedef {{path: string, mode: number, content: Uint8Array, sha256: string}} UntrackedFile
 * @typedef {{sourcePath: string, targetPath?: string, requiredPaths?: string[]}} DependencyTree
 * @typedef {{sourcePath: string, commitSha: string, trackedPatch: Uint8Array, manifest: ManifestEntry[], untrackedFiles: UntrackedFile[], dependencyTree?: DependencyTree, gitStatus: string}} ExecutorProofSubject
 * @typedef {{executable: string, args: string[], cwd: string, timeoutSeconds: number, environmentPolicy: {variables: Record<string, string>, inherit: string[]}}} ApprovedCommand
 * @typedef {{issueUrl: string, checkoutPath: string, command?: object, lockfilePath?: string}} IssueProofInput
 * @typedef {{now?: () => number, github?: object, decisions?: object, checkout?: object, boundaryOptions?: object, environment?: object|(() => object), redactionValues?: string[], gitBinary?: string}} IssueProofOptions
 */

class ProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProofError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Run the public issue-to-proof-card path for one clean Node checkout.
 *
 * @param {IssueProofInput} input
 * @param {IssueProofOptions} [options]
 */
export async function runIssueProof(input, options = {}) {
  const runtime = createRuntime(options);
  const startedAt = runtime.now();
  let ticket = null;

  try {
    validateInput(input);
    ticket = parseIssueUrl(input.issueUrl);
    let issue;
    try {
      issue = await runtime.github.readIssue({
        owner: ticket.owner,
        repository: ticket.repository,
        number: ticket.number,
        authenticated: false,
      });
    } catch (error) {
      if (error instanceof ProofError) throw error;
      throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue could not be read anonymously.');
    }
    const issueRecord = normalizeIssue(issue, ticket);
    let remoteRecords;
    try {
      remoteRecords = await runtime.checkout.readRemotes(input.checkoutPath);
    } catch (error) {
      if (error instanceof ProofError) throw error;
      throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout remotes could not be inspected.');
    }
    requireMatchingRemote(remoteRecords, ticket);
    const criteria = extractCriteria(issueRecord.body);
    await confirmCriteria(runtime.decisions, criteria);

    const inspection = runtime.checkout.inspect
      ? await runtime.checkout.inspect(input.checkoutPath, {lockfilePath: input.lockfilePath})
      : await inspectCleanCheckout(input.checkoutPath, input.lockfilePath, runtime);
    const fingerprint = normalizeInspection(inspection, input.checkoutPath);
    const command = await selectCommand(input, input.checkoutPath, runtime.checkout);
    const plan = createEvidencePlan(command, criteria);
    await approvePlan(runtime.decisions, plan);
    const environment = normalizeEnvironment(await readExecutionEnvironment(runtime, fingerprint.lockfile));
    const executionRequest = {
      proofSubject: fingerprint.executorProofSubject,
      approvedCommand: command,
      command,
      redactionValues: options.redactionValues || [],
    };
    const executionResult = await runtime.execution.execute(executionRequest);
    const endedAt = runtime.now();

    return assembleProofResult({
      ticket,
      issue: issueRecord,
      criteria,
      fingerprint,
      plan,
      environment,
      executionResult,
      startedAt,
      endedAt,
      privateValues: [input.checkoutPath],
      redactionValues: options.redactionValues || [],
    });
  } catch (error) {
    return makeProofError(error, ticket, input, options.redactionValues || []);
  }
}

function createRuntime(options) {
  const checkout = options.checkout || createCheckoutAdapter(options.gitBinary || 'git');
  const decisions = options.decisions || {};
  const github = options.github || createGithubAdapter();
  const execution = createExecutionBoundary(options.boundaryOptions || {});
  return {
    now: options.now || (() => Date.now()),
    github,
    decisions,
    checkout,
    execution,
    environment: options.environment,
  };
}

function createGithubAdapter() {
  return {
    async readIssue({owner, repository, number, authenticated}) {
      if (authenticated !== false) {
        throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public issue adapter must use anonymous access.');
      }
      let response;
      try {
        response = await fetch(`https://api.github.com/repos/${owner}/${repository}/issues/${number}`, {
          headers: {accept: 'application/vnd.github+json'},
        });
      } catch {
        throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue could not be read anonymously.');
      }
      if (!response.ok) {
        throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue could not be read anonymously.');
      }
      try {
        return await response.json();
      } catch {
        throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue response was invalid.');
      }
    },
  };
}

function createCheckoutAdapter(gitBinary) {
  return {
    gitBinary,
    async readRemotes(checkoutPath) {
      let output;
      try {
        output = await runFile(gitBinary, ['-C', checkoutPath, 'remote', '-v']);
      } catch {
        throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout has no readable Git remotes.');
      }
      return output.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        const match = line.match(/^(\S+)\s+(.+)\s+\((fetch|push)\)$/);
        return match ? {name: match[1], url: match[2], kind: match[3]} : {url: line};
      });
    },
  };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.issueUrl !== 'string' || typeof input.checkoutPath !== 'string') {
    throw new ProofError('INVALID_ISSUE_URL', 'A full GitHub issue URL and local checkout path are required.');
  }
  if (!path.isAbsolute(input.checkoutPath)) {
    throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout path must be absolute.');
  }
  if (input.command !== undefined && (!input.command || typeof input.command !== 'object')) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command is invalid.');
  }
}

function parseIssueUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProofError('INVALID_ISSUE_URL', 'The issue URL is invalid.');
  }
  const segments = parsed.pathname.split('/');
  if (parsed.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) || parsed.search || parsed.hash || (segments.length !== 5 && segments.length !== 6) || segments[0] !== '' || segments[3].toLowerCase() !== 'issues' || !/^\d+$/.test(segments[4]) || (segments.length === 6 && segments[5] !== '')) {
    throw new ProofError('INVALID_ISSUE_URL', 'The URL must identify a GitHub issue, not a pull request or another resource.');
  }
  const owner = normalizeRepositoryPart(segments[1]);
  const repository = normalizeRepositoryPart(segments[2].replace(/\.git$/i, ''));
  if (!owner || !repository || Number(segments[4]) < 1) {
    throw new ProofError('INVALID_ISSUE_URL', 'The URL must identify a GitHub issue, not a pull request or another resource.');
  }
  const number = Number(segments[4]);
  return {
    tracker: 'github',
    owner,
    repository,
    number,
    url: `https://github.com/${owner}/${repository}/issues/${number}`,
  };
}

function normalizeRepositoryPart(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizeIssue(issue, ticket) {
  if (!issue || typeof issue !== 'object' || issue.pull_request || issue.state === undefined && issue.title === undefined) {
    throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue could not be read anonymously.');
  }
  return {
    title: typeof issue.title === 'string' ? issue.title : `Issue #${ticket.number}`,
    body: typeof issue.body === 'string' ? issue.body : '',
  };
}

function requireMatchingRemote(records, ticket) {
  if (!Array.isArray(records)) throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout remotes could not be inspected.');
  const unique = new Map();
  for (const record of records) {
    const identity = normalizeRemoteIdentity(typeof record === 'string' ? record : record?.url);
    if (!identity) continue;
    const key = typeof record === 'string' ? record : record?.name || record?.url;
    if (key && !unique.has(key)) unique.set(key, identity);
  }
  const matches = [...unique.values()].filter((identity) => identity.owner === ticket.owner && identity.repository === ticket.repository);
  if (matches.length !== 1) {
    throw new ProofError('REPOSITORY_MISMATCH', 'The issue repository does not match one unambiguous local GitHub remote.');
  }
}

function normalizeRemoteIdentity(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let owner;
  let repository;
  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) {
    owner = ssh[1];
    repository = ssh[2];
  } else if (/^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() !== 'github.com') return null;
      owner = parsed.pathname.split('/')[1];
      repository = parsed.pathname.split('/')[2];
    } catch {
      return null;
    }
  } else {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      const parts = parsed.pathname.split('/').filter(Boolean);
      owner = parts[0];
      repository = parts[1];
      if (parts.length !== 2) return null;
    } catch {
      return null;
    }
  }
  if (!owner || !repository) return null;
  return {
    owner: normalizeRepositoryPart(owner),
    repository: normalizeRepositoryPart(repository.replace(/\.git$/i, '')),
  };
}

function extractCriteria(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (!heading || heading.text !== 'Acceptance criteria') continue;
    const criteria = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextHeading = parseHeading(lines[cursor]);
      if (nextHeading && nextHeading.level <= heading.level) break;
      const checkbox = parseCheckbox(lines[cursor]);
      if (checkbox) criteria.push(checkbox);
    }
    sections.push(criteria);
  }
  const found = sections.flat();
  if (found.length !== 1) {
    throw new ProofError('EXPLICIT_CRITERIA_REQUIRED', 'The issue must contain exactly one checkbox beneath an Acceptance criteria heading.');
  }
  return found.map((criterion, index) => ({
    id: `criterion-${index + 1}`,
    text: criterion.text,
    checked: criterion.checked,
    nesting: criterion.nesting,
    raw: criterion.raw,
  }));
}

function parseHeading(line) {
  const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)\s*|\s*)$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: (match[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim(),
  };
}

function parseCheckbox(line) {
  const match = line.match(/^(\s*)[-+*]\s+\[([ xX])\][ \t]+(.*)$/);
  if (!match) return null;
  return {
    text: match[3],
    checked: match[2].toLowerCase() === 'x',
    nesting: match[1].replace(/\t/g, '    ').length,
    raw: line,
  };
}

async function confirmCriteria(decisions, criteria) {
  const handler = typeof decisions === 'function' ? decisions : decisions.confirmCriteria || decisions.confirmCriterion;
  if (typeof handler !== 'function' || (await handler(criteria)) !== true) {
    throw new ProofError('CRITERIA_NOT_CONFIRMED', 'The extracted acceptance criterion was not confirmed.');
  }
}

async function approvePlan(decisions, plan) {
  const handler = typeof decisions === 'function' ? decisions : decisions.approvePlan;
  if (typeof handler !== 'function' || (await handler(plan)) !== true) {
    throw new ProofError('PLAN_NOT_APPROVED', 'The complete verification command plan was not approved.');
  }
}

async function selectCommand(input, checkoutPath, checkout) {
  if (input.command) return normalizeCommand(input.command);
  if (typeof checkout.discoverCommand === 'function') return normalizeCommand(await checkout.discoverCommand(checkoutPath));
  const packageJson = await readPackageJson(checkoutPath);
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const script = ['check', 'test', 'verify'].find((name) => typeof scripts[name] === 'string');
  if (!script) throw new ProofError('COMMAND_REQUIRED', 'A Node verification command is required.');
  return normalizeCommand({executable: 'npm', args: ['run', script]});
}

function normalizeCommand(command) {
  if (!command || typeof command.executable !== 'string' || command.executable.length === 0 || command.executable.includes('\0') || command.executable.includes('\n')) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command has no valid executable.');
  }
  const args = command.args || [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command arguments are invalid.');
  }
  const cwd = command.cwd || '.';
  validateRepositoryPath(cwd, 'COMMAND_NOT_APPROVED');
  const timeoutSeconds = command.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The command timeout must be an integer from 1 through 3,600 seconds.');
  }
  const sourcePolicy = command.environmentPolicy || {};
  const variables = sourcePolicy.variables || {};
  const inherit = sourcePolicy.inherit || [];
  if (!variables || typeof variables !== 'object' || Array.isArray(variables) || !Array.isArray(inherit)) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The command environment policy is invalid.');
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new ProofError('COMMAND_NOT_APPROVED', 'The explicit command environment is invalid.');
    }
  }
  if (inherit.some((name) => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The inherited command environment is invalid.');
  }
  return {
    executable: command.executable,
    args: [...args],
    cwd: normalizeRepositoryPath(cwd),
    timeoutSeconds,
    environmentPolicy: {
      variables: Object.fromEntries(Object.entries(variables).sort(([left], [right]) => compareStrings(left, right))),
      inherit: [...inherit].sort(compareStrings),
    },
  };
}

function createEvidencePlan(command, criteria) {
  const commands = [{id: 'command-1', command, criteria: criteria.map(({id}) => id)}];
  const hash = hashJson({commands});
  return {hash, approval: 'PENDING', commands};
}

async function inspectCleanCheckout(checkoutPath, lockfilePath, runtime) {
  const stat = await fs.stat(checkoutPath).catch(() => null);
  if (!stat?.isDirectory()) throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout is unavailable.');
  const packageJson = await readPackageJson(checkoutPath);
  const commitSha = (await gitBuffer(runtime, checkoutPath, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new ProofError('SNAPSHOT_MISMATCH', 'The local checkout commit is invalid.');
  const trackedPatch = await gitBuffer(runtime, checkoutPath, ['diff', '--binary', '--full-index', 'HEAD', '--']);
  const gitStatus = (await gitBuffer(runtime, checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).toString('utf8');
  const untrackedPaths = (await gitBuffer(runtime, checkoutPath, ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8');
  if (trackedPatch.length > 0 || gitStatus.length > 0 || splitNul(Buffer.from(untrackedPaths)).length > 0) {
    throw new ProofError('CLEAN_CHECKOUT_REQUIRED', 'Version one requires a clean local checkout.');
  }

  const manifest = await readManifest(checkoutPath, commitSha, runtime);
  const lockfile = await readLockfile(checkoutPath, lockfilePath, manifest);
  const dependencyTree = await readDependencyTree(checkoutPath, packageJson);
  const codeFingerprintBase = {
    commitSha,
    trackedPatchSha256: hashBuffer(trackedPatch),
    dirtyFiles: [],
    untrackedFiles: [],
    lockfile,
    completeness: 'COMPLETE',
  };
  const codeFingerprint = {...codeFingerprintBase, digest: hashJson(codeFingerprintBase)};
  return {
    codeFingerprint,
    lockfile,
    executorProofSubject: {
      sourcePath: checkoutPath,
      commitSha,
      trackedPatch,
      manifest,
      untrackedFiles: [],
      ...(dependencyTree ? {dependencyTree} : {}),
      gitStatus,
    },
  };
}

function normalizeInspection(inspection, checkoutPath) {
  if (!inspection || typeof inspection !== 'object' || !inspection.codeFingerprint) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout fingerprint could not be assembled.');
  }
  const codeFingerprint = inspection.codeFingerprint;
  if (codeFingerprint.completeness !== 'COMPLETE' || !codeFingerprint.digest) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout fingerprint is incomplete.');
  }
  const executorProofSubject = inspection.executorProofSubject || inspection.proofSubject;
  if (!executorProofSubject || executorProofSubject.sourcePath !== checkoutPath) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout execution subject is invalid.');
  }
  return {
    codeFingerprint,
    lockfile: codeFingerprint.lockfile || {path: null, sha256: null},
    executorProofSubject,
  };
}

async function readPackageJson(checkoutPath) {
  let text;
  try {
    text = await fs.readFile(path.join(checkoutPath, 'package.json'), 'utf8');
  } catch {
    throw new ProofError('NODE_PROJECT_REQUIRED', 'The clean checkout must contain a readable package.json.');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new ProofError('NODE_PROJECT_REQUIRED', 'The clean checkout package.json is invalid.');
  }
}

async function readManifest(checkoutPath, commitSha, runtime) {
  const output = await gitBuffer(runtime, checkoutPath, ['ls-tree', '-r', '-z', '--full-tree', commitSha]);
  const entries = [];
  for (const raw of splitNul(output)) {
    const tab = raw.indexOf(9);
    if (tab < 0) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The committed tree entry is malformed.');
    const header = raw.subarray(0, tab).toString('utf8');
    const entryPath = decodePath(raw.subarray(tab + 1));
    const [mode, type] = header.split(' ');
    validateRepositoryPath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      const subtype = type === 'commit' ? 'SUBMODULE' : mode === '120000' ? 'SYMLINK' : type === 'blob' ? 'SPECIAL_FILE' : 'UNKNOWN_ENTRY_TYPE';
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', `The checkout contains an unsupported ${subtype} entry.`, {subtype});
    }
    const absolute = path.join(checkoutPath, ...entryPath.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The clean checkout contains a non-regular file.', {subtype: stat?.isSymbolicLink() ? 'SYMLINK' : 'SPECIAL_FILE'});
    }
    entries.push({path: entryPath, mode: Number.parseInt(mode, 8) & 0o777, sha256: hashBuffer(await fs.readFile(absolute))});
  }
  return entries.sort((left, right) => compareStrings(left.path, right.path));
}

async function readLockfile(checkoutPath, selectedPath, manifest) {
  const existing = [];
  for (const name of LOCKFILE_NAMES) {
    const absolute = path.join(checkoutPath, name);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (stat?.isSymbolicLink() || stat && !stat.isFile()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The lockfile is not an ordinary file.', {subtype: stat?.isSymbolicLink() ? 'SYMLINK' : 'SPECIAL_FILE'});
    }
    if (stat?.isFile()) existing.push(name);
  }
  if (existing.length > 1 && !selectedPath) {
    throw new ProofError('LOCKFILE_SELECTION_REQUIRED', 'Multiple recognized lockfiles require an explicit selection.');
  }
  const chosen = selectedPath || existing[0] || null;
  if (chosen && (!LOCKFILE_NAMES.includes(chosen) || !existing.includes(chosen))) {
    throw new ProofError('LOCKFILE_SELECTION_REQUIRED', 'The selected lockfile is unavailable or unrecognized.');
  }
  if (!chosen) return {path: null, sha256: null};
  const entry = manifest.find(({path: entryPath}) => entryPath === chosen);
  if (!entry) throw new ProofError('SNAPSHOT_MISMATCH', 'The selected lockfile is not part of the committed tree.');
  return {path: chosen, sha256: entry.sha256};
}

async function readDependencyTree(checkoutPath, packageJson) {
  const dependencies = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some((value) => value && typeof value === 'object' && Object.keys(value).length > 0);
  const dependencyPath = path.join(checkoutPath, 'node_modules');
  const stat = await fs.stat(dependencyPath).catch(() => null);
  if (!dependencies && !stat) return null;
  return {sourcePath: dependencyPath};
}

async function readExecutionEnvironment(runtime, lockfile) {
  if (typeof runtime.environment === 'function') return runtime.environment();
  if (runtime.environment) return runtime.environment;
  const packageManagerName = lockfile.path?.startsWith('pnpm-') ? 'pnpm' : lockfile.path === 'yarn.lock' ? 'yarn' : lockfile.path?.startsWith('bun.') ? 'bun' : 'npm';
  const [gitVersion, packageManagerVersion] = await Promise.all([
    commandVersion('git', ['--version']),
    commandVersion(packageManagerName, ['--version']),
  ]);
  return {
    os: {family: process.platform, version: os.release()},
    architecture: process.arch,
    git: {name: 'git', version: gitVersion},
    runtime: {name: 'node', version: process.versions.node},
    packageManager: {name: packageManagerName, version: packageManagerVersion},
  };
}

function normalizeEnvironment(environment) {
  if (!environment || typeof environment !== 'object') {
    throw new ProofError('INTERNAL_EXECUTION_ERROR', 'The execution environment is invalid.');
  }
  const source = environment;
  const osSource = source.os && typeof source.os === 'object' ? source.os : {};
  const gitSource = source.git && typeof source.git === 'object' ? source.git : {};
  const runtimeSource = source.runtime && typeof source.runtime === 'object' ? source.runtime : {};
  const managerSource = source.packageManager && typeof source.packageManager === 'object' ? source.packageManager : {};
  const normalized = {
    os: {family: String(osSource.family || process.platform), version: String(osSource.version || os.release())},
    architecture: String(source.architecture || process.arch),
    git: {name: String(gitSource.name || 'git'), version: String(gitSource.version || 'unavailable')},
    runtime: {name: String(runtimeSource.name || 'node'), version: String(runtimeSource.version || process.versions.node)},
    packageManager: {name: String(managerSource.name || 'npm'), version: String(managerSource.version || 'unavailable')},
  };
  return normalized;
}

async function commandVersion(executable, args) {
  try {
    const result = await execFileAsync(executable, args, {encoding: 'utf8'});
    return String(result.stdout).trim().replace(/^git version\s+/i, '');
  } catch {
    return 'unavailable';
  }
}

function assembleProofResult(context) {
  const execution = classifyExecution(context.executionResult);
  if (execution.kind === 'pre-result-error') {
    return makeProofError(new ProofError(execution.code, execution.message, execution.details), context.ticket, {checkoutPath: context.privateValues[0]}, context.redactionValues);
  }

  const redactionValues = [
    ...context.redactionValues,
    ...Object.values(context.plan.commands[0].command.environmentPolicy.variables).filter((value) => value.length >= 4),
  ];
  const publicCommand = sanitizeValue(context.plan.commands[0].command, context.privateValues, redactionValues);
  const publicPlan = {
    hash: hashJson({commands: [{...context.plan.commands[0], command: publicCommand}]}),
    approval: 'APPROVED',
    commands: [{...context.plan.commands[0], command: publicCommand}],
  };
  const commandRecord = {
    id: context.plan.commands[0].id,
    command: publicCommand,
    mapping: [...context.plan.commands[0].criteria],
    ...(execution.outcome ? {execution: sanitizeValue(execution.outcome.execution, context.privateValues, redactionValues)} : {}),
    ...(execution.outcome?.output ? {output: sanitizeValue(execution.outcome.output, context.privateValues, redactionValues)} : {}),
    ...(execution.error ? {error: {code: execution.error.code, message: sanitizeText(execution.error.message, context.privateValues, redactionValues)}} : {}),
  };
  const criterionStatus = execution.status;
  const criterion = context.criteria[0];
  const criterionResult = {
    id: criterion.id,
    text: criterion.text,
    checked: criterion.checked,
    status: criterionStatus,
    evidence: [{
      type: 'automated',
      commandId: commandRecord.id,
      ...(execution.outcome ? {execution: commandRecord.execution, ...(commandRecord.output ? {output: commandRecord.output} : {})} : {error: commandRecord.error}),
    }],
    rationale: execution.rationale,
  };
  const warnings = collectWarnings(execution.outcome?.warnings || []);
  const overallStatus = criterionStatus === 'PROVED' ? 'PROVED' : criterionStatus === 'FAILED' ? 'FAILED' : 'INCOMPLETE';
  const codeFingerprint = sanitizeValue(context.fingerprint.codeFingerprint, context.privateValues, redactionValues);
  const stablePlanHash = publicPlan.hash;
  const publicEnvironment = sanitizeValue(context.environment, context.privateValues, redactionValues);
  const sealFacts = {
    criteriaHash: hashCriteria(context.criteria),
    codeFingerprint,
    evidencePlanHash: stablePlanHash,
    executionEnvironment: publicEnvironment,
    commandOutcomes: [{
      commandId: commandRecord.id,
      command: publicCommand,
      ...(execution.outcome ? {
        state: execution.outcome.execution.state,
        exitCode: execution.outcome.execution.exitCode,
        signal: execution.outcome.execution.signal,
        timeoutSeconds: publicCommand.timeoutSeconds,
        networkPolicy: execution.outcome.execution.networkPolicy || 'DENIED',
      } : {policyCode: execution.error.code}),
    }],
    criterionStatuses: [{id: criterion.id, status: criterionStatus}],
    overallStatus,
    warnings,
  };
  const proofSeal = `sha256-v1:${hashJson(sealFacts)}`;
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    ticket: {
      tracker: 'github',
      url: context.ticket.url,
      owner: context.ticket.owner,
      repository: context.ticket.repository,
      number: context.ticket.number,
      title: context.issue.title,
      criteria: context.criteria,
    },
    proofSubject: {
      criteriaHash: hashCriteria(context.criteria),
      codeFingerprint,
    },
    evidencePlan: publicPlan,
    proofRun: {
      executionEnvironment: publicEnvironment,
      startedAt: new Date(context.startedAt).toISOString(),
      endedAt: new Date(context.endedAt).toISOString(),
      durationMs: Math.max(0, context.endedAt - context.startedAt),
      runError: null,
      commands: [commandRecord],
      cleanup: execution.outcome?.cleanup || {state: 'NOT_REQUIRED'},
    },
    criterionResults: [criterionResult],
    overallStatus,
    proofSeal,
    rerunInputs: {
      issueUrl: context.ticket.url,
      repository: {owner: context.ticket.owner, name: context.ticket.repository},
      checkoutPath: LOCAL_CHECKOUT,
      criteriaHash: hashCriteria(context.criteria),
      codeFingerprintDigest: codeFingerprint.digest,
      evidencePlanHash: stablePlanHash,
    },
    warnings,
  };
  const publicArtifact = sanitizeValue(artifact, context.privateValues, redactionValues);
  const proofCard = renderProofCard(publicArtifact);
  return {kind: 'proof-run', ...publicArtifact, proofCard, json: publicArtifact};
}

function classifyExecution(result) {
  if (!result || typeof result !== 'object') return {kind: 'pre-result-error', code: 'INTERNAL_EXECUTION_ERROR', message: 'The execution boundary returned no result.'};
  if (result.kind === 'command-outcome') {
    if (result.execution?.state === 'EXITED' && result.execution.exitCode === 0) return {status: 'PROVED', outcome: result, rationale: 'The approved command exited zero in the isolated execution boundary.'};
    if (result.execution?.state === 'EXITED' || result.execution?.state === 'SIGNALED') return {status: 'FAILED', outcome: result, rationale: 'The approved command completed with a nonzero exit or terminating signal.'};
    if (result.execution?.state === 'TIMED_OUT' || result.code === 'COMMAND_TIMEOUT') return {status: 'UNVERIFIED', outcome: result, rationale: 'The approved command timed out or had no trustworthy outcome.'};
    return {kind: 'pre-result-error', code: 'INTERNAL_EXECUTION_ERROR', message: 'The execution boundary returned an invalid command outcome.'};
  }
  if (result.kind === 'run-error' && POLICY_ERROR_CODES.has(result.code)) {
    return {status: 'UNVERIFIED', error: {code: result.code, message: result.message || result.code}, rationale: `The approved command had no trustworthy outcome because ${result.code}.`};
  }
  return {
    kind: 'pre-result-error',
    code: result.code || 'INTERNAL_EXECUTION_ERROR',
    message: result.message || 'The execution boundary could not produce trustworthy evidence.',
    details: result.details,
  };
}

function collectWarnings(warnings) {
  const unique = new Map();
  for (const warning of warnings) {
    if (!warning || typeof warning.code !== 'string') continue;
    const normalized = {code: warning.code, ...(warning.stream ? {stream: warning.stream} : {})};
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) => compareStrings(left.code, right.code) || compareStrings(left.stream || '', right.stream || ''));
}

function makeProofError(error, ticket, input, redactionValues = []) {
  const proofError = error instanceof ProofError
    ? error
    : new ProofError('INTERNAL_EXECUTION_ERROR', error instanceof Error ? error.message : String(error));
  const privateValues = [input?.checkoutPath].filter(Boolean);
  return {
    kind: 'run-error',
    ...(ticket ? {schemaVersion: SCHEMA_VERSION, ticket: {tracker: 'github', url: ticket.url, owner: ticket.owner, repository: ticket.repository, number: ticket.number}} : {}),
    code: proofError.code,
    message: sanitizeText(proofError.message, privateValues, redactionValues),
    ...(Object.keys(proofError.details).length > 0 ? {details: sanitizeValue(proofError.details, privateValues, redactionValues)} : {}),
    overallStatus: null,
    proofSeal: null,
    warnings: [],
    cleanup: {state: 'NOT_REQUIRED'},
  };
}

function renderProofCard(artifact) {
  const lines = [
    'Proof card',
    `Ticket: ${artifact.ticket.owner}/${artifact.ticket.repository}#${artifact.ticket.number}`,
    `Criteria hash: ${artifact.proofSubject.criteriaHash}`,
    `Code fingerprint: ${artifact.proofSubject.codeFingerprint.digest}`,
    `Fingerprint completeness: ${artifact.proofSubject.codeFingerprint.completeness}`,
    `Plan hash: ${artifact.evidencePlan.hash}`,
    `Environment: ${artifact.proofRun.executionEnvironment.os.family} ${artifact.proofRun.executionEnvironment.os.version}, ${artifact.proofRun.executionEnvironment.architecture}`,
  ];
  for (const criterion of artifact.criterionResults) {
    lines.push(`Criterion ${criterion.id}: ${criterion.status} ${criterion.text}`);
  }
  for (const command of artifact.proofRun.commands) {
    const state = command.execution ? `${command.execution.state} ${command.execution.exitCode ?? command.execution.signal ?? ''}`.trim() : command.error.code;
    lines.push(`Command ${command.id}: ${command.command.executable} ${command.command.args.join(' ')} (${state})`);
    if (command.output) {
      const excerpts = [];
      for (const name of ['stdout', 'stderr']) {
        const excerpt = command.output.streams?.[name]?.excerpt;
        if (typeof excerpt === 'string' && excerpt.length > 0) excerpts.push(`${name}: ${excerpt}`);
      }
      const combined = limitText(excerpts.join('\n'), 4096);
      if (combined) lines.push(combined);
    }
  }
  if (artifact.warnings.length > 0) lines.push(`Warnings: ${artifact.warnings.map((warning) => warning.code).join(', ')}`);
  lines.push(`Overall: ${artifact.overallStatus}`);
  lines.push(`Rerun checkout: ${artifact.rerunInputs.checkoutPath}`);
  lines.push(`Proof seal: ${artifact.proofSeal}`);
  return lines.join('\n');
}

function sanitizeValue(value, privateValues, redactionValues = []) {
  if (typeof value === 'string') return sanitizeText(value, privateValues, redactionValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, privateValues, redactionValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, privateValues, redactionValues)]));
}

function sanitizeText(text, privateValues, redactionValues = []) {
  let result = text;
  const values = privateValues.filter((value) => typeof value === 'string' && value.length > 0).sort((left, right) => right.length - left.length);
  for (const value of values) result = result.split(value).join(LOCAL_CHECKOUT);
  for (const value of redactionValues.filter((value) => typeof value === 'string' && value.length > 0).sort((left, right) => right.length - left.length)) {
    result = result.split(value).join('<redacted>');
  }
  return result
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '<redacted>')
    .replace(/\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]+\b/g, '<redacted>')
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, '<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1<redacted>')
    .replace(/((?:token|password|secret|api[-_]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s]+)@/gi, '$1<redacted>:<redacted>@');
}

function hashCriteria(criteria) {
  return hashJson(criteria.map(({id, text}) => ({id, text: normalizePresentationWhitespace(text)})));
}

function normalizePresentationWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function validateRepositoryPath(relative, code, ordinaryOnly = false) {
  if (typeof relative !== 'string' || relative.length === 0 || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\0') || /[\u0000-\u001f\u007f]/.test(relative)) {
    throw new ProofError(ordinaryOnly ? 'UNSUPPORTED_CHECKOUT_SHAPE' : code, 'A repository-relative path is required.', {subtype: 'CONTROL_CHARACTER_PATH'});
  }
  const parts = relative.split('/');
  if (relative !== '.' && (parts.some((part) => part === '' || part === '.' || part === '..') || relative.includes('\\'))) {
    throw new ProofError(ordinaryOnly ? 'UNSUPPORTED_CHECKOUT_SHAPE' : code, 'The checkout contains a traversal path.', {subtype: 'PATH_TRAVERSAL'});
  }
  if (ordinaryOnly && relative.startsWith('.git/')) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'Git metadata cannot be part of the proof subject.');
}

function normalizeRepositoryPath(relative) {
  return relative === '.' ? '.' : relative.replace(/\/+$/, '');
}

function splitNul(value) {
  const result = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === 0) {
      if (index > start) result.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < value.length) result.push(value.subarray(start));
  return result;
}

function decodePath(value) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(value);
  } catch {
    throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a non-UTF-8 path.', {subtype: 'NON_UTF8_PATH'});
  }
}

async function gitBuffer(runtime, cwd, args) {
  try {
    const result = await runFile(runtime.checkout.gitBinary || 'git', ['-C', cwd, ...args]);
    return result.stdout;
  } catch {
    throw new ProofError('SNAPSHOT_MISMATCH', 'Git metadata inspection failed for <local-checkout>.');
  }
}

async function runFile(executable, args) {
  const result = await execFileAsync(executable, args, {encoding: 'buffer'});
  return {stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr || Buffer.alloc(0))};
}

function hashJson(value) {
  return hashBuffer(Buffer.from(canonicalJson(value)));
}

function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProofError('INTERNAL_EXECUTION_ERROR', 'A canonical value is not finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort(compareStrings).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new ProofError('INTERNAL_EXECUTION_ERROR', 'A canonical value is unsupported.');
}

function limitText(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const marker = Buffer.from('\n<excerpt-omitted>\n');
  const side = Math.floor((maxBytes - marker.length) / 2);
  return `${bytes.subarray(0, side).toString('utf8')}${marker.toString()}${bytes.subarray(-side).toString('utf8')}`;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {IssueProofOptions} [options] */
export function createIssueProofPlay(options = {}) {
  return {run(input) { return runIssueProof(input, options); }};
}
