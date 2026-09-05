#!/usr/bin/env -S rote play run
/**
 * @rote-frontmatter
 * ---
 * name: prove-the-ticket
 * description: Checks a public GitHub issue against a local Node checkout. It only supports ordinary-file Node checkouts on Linux after the required isolation checks pass. It reads public issues anonymously. Verification commands have no network access and cannot install dependencies. Version 0.1 never writes to GitHub. It does not generate or rewrite criteria, manage command dependencies, extract output, collect static or manual evidence, post comments, use private or non-Node repositories, reuse results across runs, or support macOS or Windows.
 * source: https://github.com/sivaratrisrinivas/prove-the-ticket
 * provenance:
 *   author: prove-ticket
 * parameters:
 * - name: issue_url
 *   param_type: string
 *   required: true
 *   description: Public GitHub issue URL.
 * - name: checkout_path
 *   param_type: string
 *   required: true
 *   description: Absolute path to the local Node checkout.
 * - name: confirm_criteria
 *   param_type: string
 *   required: true
 *   description: Enter yes after reviewing all extracted criteria.
 * - name: approve_plan
 *   param_type: string
 *   required: true
 *   description: Enter yes after reviewing the full command plan.
 * metadata:
 *   rote_version: 0.79.0
 *   version: 0.1.2
 *   status: released
 *   kind: atomic
 *   flow_type: sequential
 *   execution_model: steps_with_presentation
 *   format: typescript
 *   requires_endpoints: []
 *   requires_sessions: false
 *   contract:
 *     atomic: true
 *     input:
 *       type: named
 *     output:
 *       format: json
 *       destination: stdout
 *     composable: true
 *   discoverability:
 *     tags:
 *     - github
 *     - node
 *     - linux
 *     - verification
 *     - proof
 * presentation_fixtures:
 *   prove_issue: resources/presentation-fixtures/prove_issue/fixture.yaml
 * steps:
 *   prove_issue:
 *     type: process.exec
 *     timeout_ms: 600000
 *     argv:
 *     - node
 *     - '@resource{run-proof.mjs}'
 *     - $issue_url
 *     - $checkout_path
 *     - $confirm_criteria
 *     - $approve_plan
 * ---
 */

const {FlowOutput, isProcessExecBody, loadPresentationContext, stepName} =
  await import('__ROTE_PRESENTATION_SDK__');

const out = new FlowOutput();
const ctx = await loadPresentationContext();
const proof = ctx.requireAvailable(stepName('prove_issue'));

if (!isProcessExecBody(proof.body)) {
  throw new Error('prove_issue did not return a process observation');
}

const exit = proof.body.status.exit;
if (exit.kind !== 'code' || exit.code !== 0) {
  throw new Error(proof.body.stderr?.text || 'The proof run failed before producing a result.');
}

const stdout = proof.body.stdout?.text;
if (typeof stdout !== 'string' || stdout.length === 0) {
  throw new Error('The proof run produced no structured result.');
}

let result;
try {
  result = JSON.parse(stdout);
} catch {
  throw new Error('The proof run produced invalid structured output.');
}

const status = result.overallStatus ?? result.code ?? 'UNKNOWN';
const human = [
  '# prove-the-ticket 0.1.2',
  '',
  'We read the public issue anonymously.',
  'Verification commands run on Linux with no network and cannot install dependencies.',
  'This Play never writes to GitHub.',
  '',
  result.proofCard || `Run error: ${result.message || result.code || 'unknown error'}`,
].join('\n');

out.human(human);
out.summary(`prove-the-ticket: ${status}`);
out.result({
  contract: {
    issue_reads: 'ANONYMOUS_PUBLIC_ONLY',
    verification_network: 'DENIED',
    dependency_installation: 'FORBIDDEN',
    github_writes: 'NONE',
    platform: 'CAPABILITY_VALIDATED_LINUX_ONLY',
  },
  run: result,
});
