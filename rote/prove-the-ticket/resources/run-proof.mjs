import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const [issueUrl, checkoutPath, criteriaConfirmation, planConfirmation] = process.argv.slice(2);

if (![issueUrl, checkoutPath, criteriaConfirmation, planConfirmation].every((value) => typeof value === 'string' && value.length > 0)) {
  process.stderr.write('issue_url, checkout_path, confirm_criteria, and approve_plan are required.\n');
  process.exit(2);
}

const verifierEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verifier', 'index.js');

let runIssueProof;
try {
  ({runIssueProof} = await import(pathToFileURL(verifierEntry).href));
} catch {
  process.stderr.write('The packaged prove-the-ticket verifier could not be loaded.\n');
  process.exit(2);
}

const github = {
  async readIssue({owner, repository, number, authenticated}) {
    if (authenticated !== false) {
      throw new Error('The public issue adapter requires anonymous access.');
    }

    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${repository}/issues/${number}`, {
        headers: {accept: 'application/vnd.github+json'},
      });
    } catch {
      throw new Error('The public GitHub issue could not be read anonymously.');
    }
    if (!response.ok) {
      throw new Error('The public GitHub issue could not be read anonymously.');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('The public GitHub issue response was invalid.');
    }
  },
};

const result = await runIssueProof({
  issueUrl,
  checkoutPath,
}, {
  github,
  decisions: {
    async confirmCriteria() {
      return criteriaConfirmation === 'yes';
    },
    async approvePlan() {
      return planConfirmation === 'yes';
    },
  },
});

process.stdout.write(JSON.stringify(compactResult(result)));
if (result.kind === 'run-error') process.exitCode = 1;

function compactResult(value) {
  if (value.kind !== 'proof-run') return value;

  return {
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    ticket: value.ticket,
    proofSubject: value.proofSubject,
    evidencePlan: value.evidencePlan,
    proofRun: {
      executionEnvironment: value.proofRun.executionEnvironment,
      startedAt: value.proofRun.startedAt,
      endedAt: value.proofRun.endedAt,
      durationMs: value.proofRun.durationMs,
      runError: value.proofRun.runError,
      commands: value.proofRun.commands.map(({id, command, mapping, execution, error}) => ({
        id,
        command,
        mapping,
        ...(execution ? {execution} : {}),
        ...(error ? {error} : {}),
      })),
      cleanup: value.proofRun.cleanup,
    },
    criterionResults: value.criterionResults.map((criterion) => ({
      ...criterion,
      evidence: criterion.evidence.map(({type, commandId, execution, error}) => ({
        type,
        commandId,
        ...(execution ? {execution} : {}),
        ...(error ? {error} : {}),
      })),
    })),
    overallStatus: value.overallStatus,
    proofSeal: value.proofSeal,
    rerunInputs: value.rerunInputs,
    warnings: value.warnings,
    proofCard: value.proofCard,
  };
}
