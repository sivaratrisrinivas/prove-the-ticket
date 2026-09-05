import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [issueUrl, checkoutPath, criteriaConfirmation, planConfirmation] = process.argv.slice(2);

if (![issueUrl, checkoutPath, criteriaConfirmation, planConfirmation].every((value) => typeof value === 'string' && value.length > 0)) {
  process.stderr.write('issue_url, checkout_path, confirm_criteria, and approve_plan are required.\n');
  process.exit(2);
}

let runIssueProof;
try {
  ({runIssueProof} = await import(pathToFileURL(path.join(checkoutPath, 'src', 'index.js')).href));
} catch {
  process.stderr.write('The checkout does not contain the prove-the-ticket implementation.\n');
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

process.stdout.write(JSON.stringify(result));
if (result.kind === 'run-error') process.exitCode = 1;
