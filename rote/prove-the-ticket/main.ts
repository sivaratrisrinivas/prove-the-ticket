#!/usr/bin/env -S rote play run
/**
 * @rote-frontmatter
 * ---
 * name: prove-the-ticket
 * description: "Public Community Play for issue-bound verification. Supports ordinary-file Node checkouts on capability-validated Linux only; issue reads are anonymous and public-only; verification commands have no external network and cannot install dependencies; version 0.1 performs no GitHub write. This release does not claim criteria generation; does not claim criteria rewriting; does not claim command dependencies; does not claim output extraction; does not claim static evidence; does not claim manual evidence; does not claim comments; does not claim private repositories; does not claim non-Node repositories; does not claim cross-run reuse; does not claim macOS; does not claim Windows."
 * source: https://github.com/sivaratrisrinivas/prove-the-ticket
 * provenance:
 *   author: prove-ticket
 * parameters:
 * - name: issue_url
 *   param_type: string
 *   required: true
 *   description: Full public GitHub issue URL to read anonymously
 * - name: checkout_path
 *   param_type: string
 *   required: true
 *   description: Absolute path to the local Node checkout under verification
 * - name: confirm_criteria
 *   param_type: string
 *   required: true
 *   description: Type yes after reviewing the complete extracted criteria
 * - name: approve_plan
 *   param_type: string
 *   required: true
 *   description: Type yes after reviewing the complete independent command plan
 * metadata:
 *   rote_version: 0.79.0
 *   version: 0.1.0
 *   status: draft
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
  '# prove-the-ticket 0.1',
  '',
  'Public GitHub issue reads are anonymous and public-only.',
  'Verification commands run without external network access and cannot install dependencies.',
  'This release performs no GitHub write.',
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
