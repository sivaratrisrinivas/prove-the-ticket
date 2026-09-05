import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

import {hashCanonicalJson} from './canonical-json.js';
import {isAbsoluteCommandPath, isSafeCommandExecutable} from './command-policy.js';
import {createExecutionBoundary} from './execution-boundary.js';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = '1.0';
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
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
 * @typedef {{sourcePath: string, targetPath?: string, requiredPaths?: string[], digest?: string}} DependencyTree
 * @typedef {{sourcePath: string, commitSha: string, trackedPatch: Uint8Array, manifest: ManifestEntry[], untrackedFiles: UntrackedFile[], untrackedPaths?: string[], dependencyTree?: DependencyTree, gitStatus: string}} ExecutorProofSubject
 * @typedef {{executable: string, args: string[], cwd: string, timeoutSeconds: number, environmentPolicy: {variables: Record<string, string>, inherit: string[]}}} ApprovedCommand
 * @typedef {{id: string, command: ApprovedCommand, criteria: string[]}} EvidenceCommand
 * @typedef {{hash: string, approval: 'PENDING'|'APPROVED', commands: EvidenceCommand[]}} EvidencePlan
 * @typedef {{issueUrl: string, checkoutPath: string, command?: object, commands?: object[], lockfilePath?: string}} IssueProofInput
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
 * Run the public issue-to-proof-card path for one matching Node checkout.
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
      ? await runtime.checkout.inspect(input.checkoutPath, {lockfilePath: input.lockfilePath, decisions: runtime.decisions})
      : await inspectCheckout(input.checkoutPath, input.lockfilePath, runtime, runtime.decisions);
    const fingerprint = normalizeInspection(inspection, input.checkoutPath);
    const commands = await selectCommands(input, input.checkoutPath, runtime.checkout, criteria);
    const plan = await approvePlan(runtime.decisions, createEvidencePlan(commands), criteria, input.checkoutPath);
    const environment = normalizeEnvironment(await readExecutionEnvironment(runtime, fingerprint.lockfile));
    const executionResults = await executeCommands(runtime, plan, fingerprint.executorProofSubject, options.redactionValues || []);
    await recheckFreshness(runtime, input, ticket, criteria, fingerprint);
    const endedAt = runtime.now();

    return assembleProofResult({
      ticket,
      issue: issueRecord,
      criteria,
      fingerprint,
      plan,
      environment,
      executionResults,
      inspectionWarnings: fingerprint.warnings,
      startedAt,
      endedAt,
      privateValues: [input.checkoutPath],
      redactionValues: options.redactionValues || [],
    });
  } catch (error) {
    return makeProofError(error, ticket, input, [
      ...(options.redactionValues || []),
      ...explicitCommandRedactionValues(input),
    ]);
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
  if (input.command !== undefined && input.commands !== undefined) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'Provide either command or commands, not both.');
  }
  if (input.command !== undefined && (!input.command || typeof input.command !== 'object')) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command is invalid.');
  }
  if (input.commands !== undefined && (!Array.isArray(input.commands) || input.commands.length === 0)) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'At least one verification command is required.');
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
  if (parsed.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || (segments.length !== 5 && segments.length !== 6) || segments[0] !== '' || segments[3].toLowerCase() !== 'issues' || !/^\d+$/.test(segments[4]) || (segments.length === 6 && segments[5] !== '')) {
    throw new ProofError('INVALID_ISSUE_URL', 'The URL must identify a GitHub issue, not a pull request or another resource.');
  }
  const owner = normalizeRepositoryPart(segments[1]);
  const repository = normalizeRepositoryPart(segments[2].replace(/\.git$/i, ''));
  const number = Number(segments[4]);
  if (!owner || !repository || !Number.isSafeInteger(number) || number < 1) {
    throw new ProofError('INVALID_ISSUE_URL', 'The URL must identify a GitHub issue, not a pull request or another resource.');
  }
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
  const remotes = new Map();
  for (const record of records) {
    const identity = normalizeRemoteIdentity(typeof record === 'string' ? record : record?.url);
    if (!identity) continue;
    const key = typeof record === 'string' ? record : record?.name || record?.url;
    if (!key) continue;
    if (!remotes.has(key)) remotes.set(key, new Map());
    remotes.get(key).set(`${identity.owner}/${identity.repository}`, identity);
  }
  const matches = [...remotes.values()]
    .filter((identities) => identities.size === 1)
    .flatMap((identities) => [...identities.values()])
    .filter((identity) => identity.owner === ticket.owner && identity.repository === ticket.repository);
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
  } else if (/^(?:ssh|git\+ssh):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.search || parsed.hash) return null;
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) return null;
      owner = parts[0];
      repository = parts[1];
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
  const found = [];
  const seenLines = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = parseHeading(lines[index]);
    if (!heading || heading.text !== 'Acceptance criteria') continue;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextHeading = parseHeading(lines[cursor]);
      if (nextHeading && nextHeading.level <= heading.level) break;
      const checkbox = parseCheckbox(lines[cursor]);
      if (checkbox && !seenLines.has(cursor)) {
        found.push(checkbox);
        seenLines.add(cursor);
      }
    }
  }
  if (found.length === 0) {
    throw new ProofError('EXPLICIT_CRITERIA_REQUIRED', 'The issue must contain at least one checkbox beneath an Acceptance criteria heading.');
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
  const presentedCriteria = criteria.map((criterion) => ({...criterion}));
  if (typeof handler !== 'function' || (await handler(presentedCriteria)) !== true) {
    throw new ProofError('CRITERIA_NOT_CONFIRMED', 'The extracted acceptance criterion was not confirmed.');
  }
}

async function approvePlan(decisions, initialPlan, criteria, checkoutPath) {
  const handler = typeof decisions === 'function' ? decisions : decisions.approvePlan;
  if (typeof handler !== 'function') {
    throw new ProofError('PLAN_NOT_APPROVED', 'The complete verification command plan was not approved.');
  }
  let plan = initialPlan;
  while (true) {
    const presentedPlan = clonePlan(plan);
    const response = await handler(presentedPlan);
    const proposedPlan = extractPlanProposal(response, presentedPlan);
    const commands = normalizePlanCommands(proposedPlan.commands, criteria, checkoutPath);
    const hash = hashJson({commands});
    if (hash !== plan.hash) {
      plan = {hash, approval: 'PENDING', commands};
      continue;
    }
    if (response === true || response && typeof response === 'object' && response.approved === true) {
      return {...plan, approval: 'APPROVED'};
    }
    throw new ProofError('PLAN_NOT_APPROVED', 'The complete verification command plan was not approved.');
  }
}

function extractPlanProposal(response, presentedPlan) {
  if (response && typeof response === 'object' && response.plan && typeof response.plan === 'object') return response.plan;
  if (response && typeof response === 'object' && Array.isArray(response.commands)) return response;
  return presentedPlan;
}

function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

async function selectCommands(input, checkoutPath, checkout, criteria) {
  if (input.commands !== undefined) return normalizeCommandEntries(input.commands, criteria, checkoutPath);
  if (input.command) return normalizeCommandEntries([input.command], criteria, checkoutPath);
  if (typeof checkout.discoverCommands === 'function') return normalizeCommandEntries(await checkout.discoverCommands(checkoutPath), criteria, checkoutPath);
  if (typeof checkout.discoverCommand === 'function') return normalizeCommandEntries([await checkout.discoverCommand(checkoutPath)], criteria, checkoutPath);
  const packageJson = await readPackageJson(checkoutPath);
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {};
  const names = ['check', 'test', 'verify'].filter((name) => typeof scripts[name] === 'string');
  if (names.length === 0) throw new ProofError('COMMAND_REQUIRED', 'A Node verification command is required.');
  return normalizeCommandEntries(names.map((name) => ({executable: 'npm', args: ['run', name]})), criteria, checkoutPath);
}

function normalizeCommandEntries(entries, criteria, checkoutPath) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'At least one verification command is required.');
  }
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command is invalid.');
    }
    rejectUnsupportedCommandFields(entry);
    const mapping = entry.criteria === undefined ? criteria.map(({id}) => id) : entry.criteria;
    const command = normalizeCommand(entry, checkoutPath);
    normalized.push({
      id: createCommandId(command),
      command,
      criteria: normalizeCriteriaMapping(mapping, criteria),
    });
  }
  return normalized;
}

function normalizePlanCommands(entries, criteria, checkoutPath) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ProofError('PLAN_NOT_APPROVED', 'The verification plan must contain at least one command.');
  }
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.command || typeof entry.command !== 'object') {
      throw new ProofError('PLAN_NOT_APPROVED', 'The verification plan contains an invalid command.');
    }
    rejectUnsupportedCommandFields(entry, 'PLAN_NOT_APPROVED');
    const command = normalizeCommand(entry.command, checkoutPath);
    normalized.push({
      id: createCommandId(command),
      command,
      criteria: normalizeCriteriaMapping(entry.criteria, criteria),
    });
  }
  return normalized;
}

function normalizeCriteriaMapping(mapping, criteria) {
  if (!Array.isArray(mapping) || mapping.length === 0 || mapping.some((id) => typeof id !== 'string')) {
    throw new ProofError('PLAN_NOT_APPROVED', 'Each command must have a criterion mapping.');
  }
  const known = new Set(criteria.map(({id}) => id));
  const seen = new Set();
  for (const id of mapping) {
    if (!known.has(id) || seen.has(id)) {
      throw new ProofError('PLAN_NOT_APPROVED', 'A command maps to an unknown or repeated criterion.');
    }
    seen.add(id);
  }
  return [...mapping];
}

function normalizeCommand(command, checkoutPath) {
  rejectUnsupportedCommandFields(command);
  if (!command || typeof command.executable !== 'string' || command.executable.length === 0 || command.executable.includes('\0') || command.executable.includes('\n')) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command has no valid executable.');
  }
  if (!isSafeCommandExecutable(command.executable)) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The executable path is not an approved system command.');
  }
  if (isAbsoluteCommandPath(command.executable) && isPathInside(checkoutPath, command.executable)) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The executable cannot be loaded from the local checkout.');
  }
  const args = command.args || [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'The verification command arguments are invalid.');
  }
  if (args.some((arg) => isAbsoluteCommandPath(arg))) {
    throw new ProofError('COMMAND_NOT_APPROVED', 'Command arguments cannot contain absolute paths.');
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

function createCommandId(command) {
  const identity = hashJson(commandIdentity(command));
  return `command-${identity}`;
}

function commandIdentity(command) {
  return {
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    timeoutSeconds: command.timeoutSeconds,
    environmentPolicy: command.environmentPolicy,
  };
}

function rejectUnsupportedCommandFields(command, code = 'COMMAND_NOT_APPROVED') {
  if (['dependsOn', 'dependencies', 'prerequisites', 'evidence', 'outputEvidence', 'evidenceType', 'useOutputAsEvidence'].some((key) => Object.hasOwn(command || {}, key))) {
    throw new ProofError(code, 'Command dependencies and output evidence are not supported.');
  }
}

function createEvidencePlan(commands) {
  const hash = hashJson({commands});
  return {hash, approval: 'PENDING', commands};
}

async function executeCommands(runtime, plan, proofSubject, redactionValues) {
  const results = [];
  for (const entry of plan.commands) {
    results.push(await runtime.execution.execute({
      proofSubject,
      approvedCommand: entry.command,
      command: entry.command,
      redactionValues,
    }));
  }
  return results;
}

async function recheckFreshness(runtime, input, ticket, criteria, fingerprint) {
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
    throw new ProofError('PUBLIC_ISSUE_UNAVAILABLE', 'The public GitHub issue could not be rechecked anonymously.');
  }
  const currentCriteria = extractCriteria(normalizeIssue(issue, ticket).body);
  if (hashCriteria(currentCriteria) !== hashCriteria(criteria)) {
    throw new ProofError('CRITERIA_CHANGED', 'The acceptance criteria changed during the proof run.');
  }

  const approvedUntrackedPaths = fingerprint.executorProofSubject.untrackedFiles.map(({path: entryPath}) => entryPath);
  const inspection = runtime.checkout.inspect
    ? await runtime.checkout.inspect(input.checkoutPath, {lockfilePath: input.lockfilePath, approvedUntrackedPaths})
    : await inspectCheckout(input.checkoutPath, input.lockfilePath, runtime, runtime.decisions, approvedUntrackedPaths);
  const currentFingerprint = normalizeInspection(inspection, input.checkoutPath);
  if (currentFingerprint.codeFingerprint.digest !== fingerprint.codeFingerprint.digest
    || !samePathList(currentFingerprint.executorProofSubject.untrackedPaths, fingerprint.executorProofSubject.untrackedPaths)) {
    throw new ProofError('SOURCE_CHANGED', 'The checkout fingerprint changed during the proof run.');
  }
}

async function inspectCheckout(checkoutPath, lockfilePath, runtime, decisions, approvedUntrackedPaths) {
  const stat = await fs.stat(checkoutPath).catch(() => null);
  if (!stat?.isDirectory()) throw new ProofError('REPOSITORY_MISMATCH', 'The local checkout is unavailable.');
  const commitSha = (await gitBuffer(runtime, checkoutPath, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new ProofError('SNAPSHOT_MISMATCH', 'The local checkout commit is invalid.');
  const trackedPatch = await gitBuffer(runtime, checkoutPath, ['diff', '--binary', '--full-index', 'HEAD', '--']);
  const gitStatus = (await gitBuffer(runtime, checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all'])).toString('utf8');
  const dirtyFiles = await readDirtyFiles(checkoutPath, runtime);
  const untrackedPaths = splitNul(await gitBuffer(runtime, checkoutPath, ['ls-files', '--others', '--exclude-standard', '-z']))
    .map(decodePath)
    .sort(compareStrings);
  const untracked = await inspectUntrackedFiles(checkoutPath, untrackedPaths, decisions, approvedUntrackedPaths);
  if (untrackedPaths.includes('package.json') && !untracked.files.some(({path: entryPath}) => entryPath === 'package.json')) {
    throw new ProofError('NODE_PROJECT_REQUIRED', 'The checkout package.json was not included in the approved proof subject.');
  }
  const packageJson = await readPackageJson(checkoutPath);
  const manifest = await readManifest(checkoutPath, commitSha, runtime, untracked.files);
  const lockfile = await readLockfile(checkoutPath, lockfilePath, manifest);
  const dependencyTree = await readDependencyTree(checkoutPath, packageJson);
  const dependencyDigest = dependencyTree?.digest || null;
  const codeFingerprintBase = {
    commitSha,
    trackedPatchSha256: hashBuffer(trackedPatch),
    dirtyFiles,
    untrackedFiles: untracked.files.map(({path: entryPath, size, sha256}) => ({path: entryPath, size, sha256})),
    lockfile,
    dependencyDigest,
    completeness: untracked.warnings.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
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
      untrackedFiles: untracked.files,
      untrackedPaths,
      ...(dependencyTree ? {dependencyTree} : {}),
      gitStatus,
    },
    warnings: untracked.warnings,
  };
}

async function readDirtyFiles(checkoutPath, runtime) {
  const output = await gitBuffer(runtime, checkoutPath, ['status', '--porcelain=v1', '--untracked-files=all', '-z']);
  const dirtyFiles = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git status output is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    const record = output.subarray(offset, end);
    if (record.length < 4 || record[2] !== 32) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git status output is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    }
    const status = record.subarray(0, 2).toString('ascii');
    const entryPath = decodePath(record.subarray(3));
    validateRepositoryPath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (status !== '??' && status !== '!!') dirtyFiles.push({path: entryPath, status});
    offset = end + 1;
    if (/[RC]/.test(status)) {
      const renamedEnd = output.indexOf(0, offset);
      if (renamedEnd < 0) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git status rename record is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
      const renamedPath = decodePath(output.subarray(offset, renamedEnd));
      validateRepositoryPath(renamedPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
      dirtyFiles.push({path: renamedPath, status});
      offset = renamedEnd + 1;
    }
  }
  return dirtyFiles.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.status, right.status));
}

async function inspectUntrackedFiles(checkoutPath, untrackedPaths, decisions, approvedUntrackedPaths) {
  const previews = [];
  for (const entryPath of untrackedPaths) {
    validateRepositoryPath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    const absolute = path.join(checkoutPath, ...entryPath.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) throw new ProofError('SNAPSHOT_MISMATCH', 'An untracked path is unavailable.');
    if (stat.isSymbolicLink()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains an untracked symlink.', {subtype: 'SYMLINK'});
    }
    if (!stat.isFile()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains an untracked special file.', {subtype: 'SPECIAL_FILE'});
    }
    const secretReason = secretPathReason(entryPath);
    const reason = secretReason || stat.size > MAX_UNTRACKED_FILE_BYTES
      ? secretReason || 'FILE_TOO_LARGE'
      : null;
    previews.push({path: entryPath, size: stat.size, ...(reason ? {eligible: false, reason} : {eligible: true})});
  }
  if (previews.length === 0) return {files: [], warnings: []};

  let includedBytes = 0;
  for (const preview of previews) {
    if (!preview.eligible) continue;
    if (includedBytes + preview.size > MAX_UNTRACKED_BYTES) {
      preview.eligible = false;
      preview.reason = 'AGGREGATE_LIMIT';
    } else {
      includedBytes += preview.size;
    }
  }

  const selectedPaths = approvedUntrackedPaths === undefined
    ? await approveUntracked(decisions, previews)
    : new Set(approvedUntrackedPaths);
  const files = [];
  const warnings = [];
  for (const preview of previews) {
    if (!preview.eligible) {
      warnings.push({code: 'FINGERPRINT_INCOMPLETE', path: preview.path, reason: preview.reason});
      continue;
    }
    if (!selectedPaths.has(preview.path)) {
      warnings.push({code: 'FINGERPRINT_INCOMPLETE', path: preview.path, reason: 'NOT_APPROVED'});
      continue;
    }
    const absolute = path.join(checkoutPath, ...preview.path.split('/'));
    const content = await fs.readFile(absolute);
    files.push({
      path: preview.path,
      mode: (await fs.stat(absolute)).mode & 0o777,
      content,
      size: content.length,
      sha256: hashBuffer(content),
    });
  }
  return {files, warnings};
}

async function approveUntracked(decisions, previews) {
  const handler = decisions && (decisions.confirmUntracked || decisions.approveUntracked);
  const eligible = previews.filter(({eligible}) => eligible).map(({path: entryPath}) => entryPath);
  if (typeof handler !== 'function') {
    throw new ProofError('UNTRACKED_NOT_APPROVED', 'The non-ignored untracked paths require explicit approval.');
  }
  const response = await handler(previews.map((preview) => ({...preview})));
  if (response === true || response?.approved === true) return new Set(eligible);
  const approved = Array.isArray(response) ? response : response?.approvedPaths;
  if (Array.isArray(approved) && approved.every((entryPath) => typeof entryPath === 'string' && eligible.includes(entryPath))) {
    return new Set(approved);
  }
  throw new ProofError('UNTRACKED_NOT_APPROVED', 'The untracked path set was not approved.');
}

function secretPathReason(entryPath) {
  const lowerPath = asciiLower(entryPath);
  const secretComponent = lowerPath.split('/').some((component) => component === '.env'
    || component.startsWith('.env.')
    || component === '.envrc'
    || component === '.npmrc'
    || component === '.yarnrc'
    || component === '.yarnrc.yml'
    || component === 'id_rsa'
    || component === 'id_dsa'
    || component === 'id_ed25519'
    || component === 'credentials'
    || component.startsWith('credentials.')
    || component === 'secret'
    || component.startsWith('secret.')
    || component.endsWith('.secret')
    || component === 'token'
    || component.startsWith('token.')
    || component.endsWith('.token'));
  return secretComponent || ['.pem', '.key', '.p8', '.p12', '.pfx', '.jks', '.keystore'].some((suffix) => lowerPath.endsWith(suffix)) ? 'SECRET_PATH' : null;
}

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function normalizeInspection(inspection, checkoutPath) {
  if (!inspection || typeof inspection !== 'object' || !inspection.codeFingerprint) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout fingerprint could not be assembled.');
  }
  const codeFingerprint = inspection.codeFingerprint;
  const {digest, ...fingerprintFacts} = codeFingerprint;
  if (!['COMPLETE', 'INCOMPLETE'].includes(codeFingerprint.completeness)
    || typeof digest !== 'string'
    || !/^[0-9a-f]{64}$/i.test(digest)
    || hashJson(fingerprintFacts) !== digest.toLowerCase()) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout fingerprint is invalid.');
  }
  const executorProofSubject = inspection.executorProofSubject || inspection.proofSubject;
  if (!executorProofSubject || executorProofSubject.sourcePath !== checkoutPath) {
    throw new ProofError('SNAPSHOT_MISMATCH', 'The checkout execution subject is invalid.');
  }
  return {
    codeFingerprint,
    lockfile: codeFingerprint.lockfile || {path: null, sha256: null},
    executorProofSubject,
    warnings: Array.isArray(inspection.warnings) ? inspection.warnings : [],
  };
}

function samePathList(left = [], right = []) {
  return JSON.stringify([...left].sort(compareStrings)) === JSON.stringify([...right].sort(compareStrings));
}

async function readPackageJson(checkoutPath) {
  let text;
  try {
    text = await fs.readFile(path.join(checkoutPath, 'package.json'), 'utf8');
  } catch {
    throw new ProofError('NODE_PROJECT_REQUIRED', 'The checkout must contain a readable package.json.');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch {
    throw new ProofError('NODE_PROJECT_REQUIRED', 'The checkout package.json is invalid.');
  }
}

async function readManifest(checkoutPath, commitSha, runtime, untrackedFiles) {
  const committed = await gitBuffer(runtime, checkoutPath, ['ls-tree', '-r', '-z', '--full-tree', commitSha]);
  for (const raw of splitNul(committed)) {
    const tab = raw.indexOf(9);
    if (tab < 0) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The committed tree entry is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    const header = raw.subarray(0, tab).toString('ascii');
    const entryPath = decodePath(raw.subarray(tab + 1));
    const [mode, type] = header.split(' ');
    validateRepositoryPath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      const subtype = type === 'commit' ? 'SUBMODULE' : mode === '120000' ? 'SYMLINK' : type === 'blob' ? 'SPECIAL_FILE' : 'UNKNOWN_ENTRY_TYPE';
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', `The checkout contains an unsupported ${subtype} entry.`, {subtype});
    }
  }

  const indexOutput = await gitBuffer(runtime, checkoutPath, ['ls-files', '--stage', '-z']);
  const entries = [];
  const seen = new Set();
  for (const raw of splitNul(indexOutput)) {
    const tab = raw.indexOf(9);
    if (tab < 0) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git index entry is malformed.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    const [mode] = raw.subarray(0, tab).toString('ascii').split(' ');
    const entryPath = decodePath(raw.subarray(tab + 1));
    validateRepositoryPath(entryPath, 'UNSUPPORTED_CHECKOUT_SHAPE', true);
    if (seen.has(entryPath)) throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The Git index contains multiple stages for one path.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
    seen.add(entryPath);
    if (!['100644', '100755'].includes(mode)) {
      const subtype = mode === '120000' ? 'SYMLINK' : mode === '160000' ? 'SUBMODULE' : 'UNKNOWN_ENTRY_TYPE';
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', `The checkout contains an unsupported ${subtype} entry.`, {subtype});
    }
    const attr = await gitBuffer(runtime, checkoutPath, ['check-attr', 'filter', '--cached', '--', entryPath]);
    if (attr.toString('utf8').trim().endsWith(': lfs')) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a Git LFS-managed path.', {subtype: 'GIT_LFS'});
    }
    const absolute = path.join(checkoutPath, ...entryPath.split('/'));
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a tracked symlink.', {subtype: 'SYMLINK'});
    }
    if (!stat.isFile()) {
      throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The checkout contains a tracked special file.', {subtype: 'SPECIAL_FILE'});
    }
    entries.push({path: entryPath, mode: stat.mode & 0o777, sha256: hashBuffer(await fs.readFile(absolute))});
  }

  for (const entry of untrackedFiles || []) {
    entries.push({path: entry.path, mode: entry.mode, sha256: entry.sha256});
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
  const stat = await fs.lstat(dependencyPath).catch(() => null);
  if (!dependencies && !stat) return null;
  if (!stat) return {sourcePath: dependencyPath};
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new ProofError('DEPENDENCIES_UNAVAILABLE', 'The existing dependency tree is unavailable.');
  }
  return {sourcePath: dependencyPath, digest: await hashDependencyTree(dependencyPath)};
}

async function hashDependencyTree(root) {
  const entries = [];
  async function visit(current, relative) {
    for (const name of (await fs.readdir(current)).sort(compareStrings)) {
      const next = path.join(current, name);
      const nextRelative = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink()) {
        entries.push({path: nextRelative, kind: 'symlink', target: await fs.readlink(next)});
      } else if (stat.isDirectory()) {
        await visit(next, nextRelative);
      } else if (stat.isFile()) {
        entries.push({path: nextRelative, kind: 'file', mode: stat.mode & 0o777, sha256: hashBuffer(await fs.readFile(next))});
      } else {
        throw new ProofError('UNSUPPORTED_CHECKOUT_SHAPE', 'The dependency tree contains an unsupported entry.', {subtype: 'UNKNOWN_ENTRY_TYPE'});
      }
    }
  }
  await visit(root, '');
  return hashJson(entries);
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
  const classifiedAttempts = context.plan.commands.map((planned, index) => ({
    planned,
    classification: classifyExecution(context.executionResults[index]),
  }));
  const redactionValues = [
    ...context.redactionValues,
    ...context.plan.commands.flatMap(({command}) => Object.values(command.environmentPolicy.variables).filter((value) => value.length > 0)),
  ];
  const runError = classifiedAttempts.find(({classification}) => classification.kind === 'pre-result-error');
  if (runError) {
    const errorResult = makeProofError(new ProofError(runError.classification.code, runError.classification.message, runError.classification.details), context.ticket, {checkoutPath: context.privateValues[0]}, redactionValues);
    if (runError.classification.cleanup) errorResult.cleanup = runError.classification.cleanup;
    if (runError.classification.sourceIntegrity) errorResult.sourceIntegrity = runError.classification.sourceIntegrity;
    return errorResult;
  }
  const publicCommands = context.plan.commands.map((planned) => ({
    ...planned,
    command: sanitizeValue(planned.command, context.privateValues, redactionValues),
  }));
  const publicPlan = {
    hash: hashJson({commands: publicCommands}),
    approval: 'APPROVED',
    commands: publicCommands,
  };
  const attempts = classifiedAttempts.map((attempt, index) => ({
    ...attempt,
    record: createCommandRecord(publicCommands[index], attempt.classification, context, redactionValues),
  }));
  const commandRecords = attempts.map(({record}) => record);
  const criterionResults = context.criteria.map((criterion) => createCriterionResult(criterion, attempts));
  const warnings = collectWarnings([
    ...(context.inspectionWarnings || []),
    ...attempts.flatMap(({classification}) => classification.outcome?.warnings || []),
  ], context.privateValues, redactionValues);
  const overallStatus = aggregateOverallStatus(criterionResults, context.fingerprint.codeFingerprint);
  const codeFingerprint = sanitizeValue(context.fingerprint.codeFingerprint, context.privateValues, redactionValues);
  const stablePlanHash = publicPlan.hash;
  const publicEnvironment = sanitizeValue(context.environment, context.privateValues, redactionValues);
  const sealFacts = {
    criteriaHash: hashCriteria(context.criteria),
    codeFingerprint,
    evidencePlanHash: stablePlanHash,
    executionEnvironment: publicEnvironment,
    commandOutcomes: attempts.map(({record, classification}) => ({
      commandId: record.id,
      command: record.command,
      ...(classification.outcome ? {
        state: classification.outcome.execution.state,
        exitCode: classification.outcome.execution.exitCode,
        signal: classification.outcome.execution.signal,
        timeoutSeconds: record.command.timeoutSeconds,
        networkPolicy: classification.outcome.execution.networkPolicy || 'DENIED',
      } : {policyCode: classification.error.code}),
    })),
    criterionStatuses: criterionResults.map(({id, status}) => ({id, status})),
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
      commands: commandRecords,
      cleanup: summarizeCleanup(attempts.map(({classification}) => classification)),
    },
    criterionResults,
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

function createCommandRecord(planned, classification, context, redactionValues) {
  return {
    id: planned.id,
    command: planned.command,
    mapping: [...planned.criteria],
    ...(classification.outcome ? {execution: sanitizeValue(classification.outcome.execution, context.privateValues, redactionValues)} : {}),
    ...(classification.outcome?.output ? {output: sanitizeValue(classification.outcome.output, context.privateValues, redactionValues)} : {}),
    ...(classification.error ? {error: {code: classification.error.code, message: sanitizeText(classification.error.message, context.privateValues, redactionValues)}} : {}),
  };
}

function createCriterionResult(criterion, attempts) {
  const mapped = attempts.filter(({planned}) => planned.criteria.includes(criterion.id));
  const status = aggregateCriterionStatus(mapped.map(({classification}) => classification.status));
  return {
    id: criterion.id,
    text: criterion.text,
    checked: criterion.checked,
    status,
    evidence: mapped.map(({record}) => ({
      type: 'automated',
      commandId: record.id,
      ...(record.execution ? {execution: record.execution, ...(record.output ? {output: record.output} : {})} : {error: record.error}),
    })),
    rationale: criterionRationale(status, mapped.length),
  };
}

function aggregateCriterionStatus(statuses) {
  if (statuses.some((status) => status === 'FAILED')) return 'FAILED';
  if (statuses.length === 0 || statuses.some((status) => status === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'PROVED';
}

function criterionRationale(status, commandCount) {
  if (commandCount === 0) return 'No approved command was mapped to this criterion.';
  if (status === 'FAILED') return 'A mapped command completed with a nonzero exit or terminating signal.';
  if (status === 'UNVERIFIED') return 'A mapped command had no trustworthy outcome.';
  return 'Every mapped command exited zero in the isolated execution boundary.';
}

function aggregateOverallStatus(criterionResults, codeFingerprint = {completeness: 'COMPLETE'}) {
  if (criterionResults.some(({status}) => status === 'FAILED')) return 'FAILED';
  if (codeFingerprint.completeness !== 'COMPLETE' || criterionResults.some(({status}) => status === 'UNVERIFIED')) return 'INCOMPLETE';
  return 'PROVED';
}

function summarizeCleanup(classifications) {
  const cleanups = classifications.map(({outcome}) => outcome?.cleanup).filter(Boolean);
  if (cleanups.length === 0 || cleanups.every(({state}) => state === 'NOT_REQUIRED')) return {state: 'NOT_REQUIRED'};
  const failed = cleanups.find(({state}) => state === 'FAILED');
  if (failed) return failed;
  if (cleanups.every(({state}) => state === 'CLEANED' || state === 'NOT_REQUIRED')) return {state: 'CLEANED'};
  return cleanups[0];
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
    sourceIntegrity: result.sourceIntegrity,
    cleanup: result.cleanup,
  };
}

function collectWarnings(warnings, privateValues = [], redactionValues = []) {
  const unique = new Map();
  for (const warning of warnings) {
    if (!warning || typeof warning.code !== 'string') continue;
    const normalized = {
      code: warning.code,
      ...(warning.path ? {path: warning.reason === 'SECRET_PATH' ? '<redacted>' : sanitizeText(warning.path, privateValues, redactionValues)} : {}),
      ...(warning.reason ? {reason: warning.reason} : {}),
      ...(warning.stream ? {stream: warning.stream} : {}),
    };
    const identity = warning.code === 'FINGERPRINT_INCOMPLETE' && warning.path
      ? JSON.stringify({code: warning.code, path: warning.path, reason: warning.reason})
      : JSON.stringify(normalized);
    unique.set(identity, normalized);
  }
  return [...unique.values()].sort((left, right) => compareStrings(left.code, right.code)
    || compareStrings(left.reason || '', right.reason || '')
    || compareStrings(left.path || '', right.path || '')
    || compareStrings(left.stream || '', right.stream || ''));
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
    sourceIntegrity: proofError.code === 'SOURCE_CHANGED' ? 'CHANGED' : 'UNKNOWN',
    overallStatus: null,
    proofSeal: null,
    warnings: [],
    cleanup: {state: 'NOT_REQUIRED'},
  };
}

function explicitCommandRedactionValues(input) {
  const commands = [
    input?.command,
    ...(Array.isArray(input?.commands) ? input.commands : []),
  ];
  return commands.flatMap((command) => Object.values(command?.environmentPolicy?.variables || {}))
    .filter((value) => typeof value === 'string' && value.length > 0);
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
  if (artifact.warnings.length > 0) lines.push(`Warnings: ${artifact.warnings.map((warning) => [warning.code, warning.reason, warning.path].filter(Boolean).join(' ')).join(', ')}`);
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

function isPathInside(root, candidate) {
  if (!root || !isAbsoluteCommandPath(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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
  try {
    return hashCanonicalJson(value);
  } catch {
    throw new ProofError('INTERNAL_EXECUTION_ERROR', 'A canonical value is unsupported.');
  }
}

function hashBuffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function limitText(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const marker = Buffer.from('\n<excerpt-omitted>\n');
  const side = Math.floor((maxBytes - marker.length) / 2);
  return `${trimUtf8End(bytes.subarray(0, side)).toString('utf8')}${marker.toString()}${trimUtf8Start(bytes.subarray(-side)).toString('utf8')}`;
}

function trimUtf8End(value) {
  for (let end = value.length; end >= Math.max(0, value.length - 4); end -= 1) {
    try {
      new TextDecoder('utf-8', {fatal: true}).decode(value.subarray(0, end));
      return value.subarray(0, end);
    } catch {}
  }
  return Buffer.alloc(0);
}

function trimUtf8Start(value) {
  for (let start = 0; start <= Math.min(4, value.length); start += 1) {
    try {
      new TextDecoder('utf-8', {fatal: true}).decode(value.subarray(start));
      return value.subarray(start);
    } catch {}
  }
  return Buffer.alloc(0);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {IssueProofOptions} [options] */
export function createIssueProofPlay(options = {}) {
  return {run(input) { return runIssueProof(input, options); }};
}
