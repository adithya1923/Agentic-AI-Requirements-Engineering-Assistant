import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProjectFactors, rankSdlcApproaches, buildSdlcWorkflow, buildSdlcArtefacts, createSdlcAnalysis } from '../src/services/sdlc-agent.js';
import { maskSensitiveText } from '../src/services/sensitive-data.js';
import { buildRequirementCandidates } from '../src/services/requirement-extraction.js';

test('SDLC factors are bounded, transparent, and deterministic from project records', () => {
  const requirements = [
    { id: 'r1', requirement_type: 'SECURITY', requirement_text: 'Staff shall review access.', source_input_id: 'i1', source_evidence: 'Staff shall review access.', review_status: 'DRAFT' },
    { id: 'r2', requirement_type: 'FUNCTIONAL', requirement_text: 'Users can provide feedback.', source_input_id: 'i1', source_evidence: 'Users can provide feedback.', review_status: 'DRAFT' },
  ];
  const project = { name: 'Synthetic Project', selected_domain: 'General Financial' };
  const findings = [{ severity: 'HIGH', finding_type: 'AMBIGUITY' }];
  const factors = calculateProjectFactors(project, requirements, findings);
  assert.deepEqual(calculateProjectFactors(project, requirements, findings), factors);
  assert.ok(Object.values(factors).every((value) => Number.isInteger(value) && value >= 1 && value <= 5));
  assert.deepEqual(rankSdlcApproaches(factors), rankSdlcApproaches(factors));
  assert.equal(rankSdlcApproaches(factors).length, 8);
});

test('workflow and artefacts preserve requirement IDs and source evidence', () => {
  const requirements = [{ id: 'req-1', project_id: 'p', source_input_id: 'i', requirement_type: 'FUNCTIONAL', requirement_text: 'System shall show status.', source_evidence: 'show status', review_status: 'DRAFT' }];
  const workflow = buildSdlcWorkflow('AGILE', requirements);
  const artefacts = buildSdlcArtefacts({ name: 'Project' }, requirements, workflow);
  assert.ok(workflow.length >= 4);
  assert.ok(workflow.every((stage) => stage.requirementIds.includes('req-1')));
  assert.equal(artefacts.length, 3);
  assert.ok(artefacts[0].content.includes('System shall show status.'));
  assert.ok(artefacts[1].content.includes('show status'));
});

test('sensitive-data masking protects common identifiers and preserves offsets', () => {
  const source = 'Contact demo.person@example.test and use synthetic account 1234567890123456.';
  const masked = maskSensitiveText(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.includes('demo.person@example.test'), false);
  assert.equal(masked.includes('1234567890123456'), false);
});

test('Agent 2 scores approved persisted requirements and saves explanation, ranking and traceable artefacts', async () => {
  const req = { id: 'req-1', project_id: 'project-1', source_input_id: 'input-1', requirement_type: 'FUNCTIONAL', requirement_text: 'Staff can review synthetic applications.', source_evidence: 'Staff can review synthetic applications.', review_status: 'APPROVED' };
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{ id: 'project-1', name: 'Synthetic project', selected_domain: 'General Financial' }] };
    if (sql.includes('FROM candidate_requirements') && !sql.includes('INSERT INTO sdlc_analyses')) return { rowCount: 1, rows: [req] };
    if (sql.includes('FROM requirement_analysis_findings')) return { rowCount: 1, rows: [{ severity: 'MEDIUM', finding_type: 'AMBIGUITY' }] };
    if (sql.includes('INSERT INTO sdlc_analyses')) return { rowCount: 1, rows: [{ id: 'analysis-1', project_id: params[0], status: 'DRAFT', factors: params[1], ranking: JSON.parse(params[2]), recommendation: params[3], explanation: params[4], workflow: JSON.parse(params[5]), artefacts: JSON.parse(params[6]), requirement_ids: params[7], provider: params[8], model_name: params[9], created_at: new Date(), updated_at: new Date() }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const explanation = await createSdlcAnalysis({ database: db, projectId: 'project-1', generateOutput: async (request, options) => {
    assert.equal(request.modelPurpose, 'sdlc-explanation');
    assert.deepEqual(options.fallbacks, []);
    options.onProviderUsed({ provider: 'gemini', model: 'test-model' });
    return JSON.stringify({ relevantFactors: ['requirementStability', 'requirementClarity'] });
  } });
  assert.equal(explanation.status, 'DRAFT');
  assert.equal(explanation.requirementIds[0], 'req-1');
  assert.equal(explanation.provider, 'gemini');
  assert.match(explanation.explanation, /requirement stability 2\/5, requirement clarity 2\/5/);
  assert.ok(explanation.artefacts.some((item) => item.type === 'TRACEABILITY' && item.content.includes('Staff can review synthetic applications.')));
  assert.match(calls[1].sql, /review_status='APPROVED'/);
  assert.equal(calls[3].params[7][0], 'req-1');
});

test('candidate segmentation atomizes coordinated obligations without changing their source spans', () => {
  const source = 'The system shall register applicants, validate documents, perform credit checks, notify applicants, and allow administrators to review applications.';
  const candidates = buildRequirementCandidates(source, 'input-id');
  assert.equal(candidates.length, 5);
  assert.deepEqual(candidates.map((candidate) => source.slice(candidate.start, candidate.end)), candidates.map((candidate) => candidate.text));
  assert.ok(candidates.some(({ text }) => text.includes('validate documents')));
  assert.ok(candidates.some(({ text }) => text.includes('review applications')));
  assert.equal(candidates[1].requirementText, 'The system shall validate documents,');
  const list = 'Claims staff shall register each claim with the policy number, claimant details, incident date, and supporting documents.';
  assert.deepEqual(buildRequirementCandidates(list, 'input-list').map(({ text }) => text), [list]);
  const coordinated = 'The system shall assign a unique claim reference and show the claim status to the claimant.';
  const split = buildRequirementCandidates(coordinated, 'input-coordinated');
  assert.deepEqual(split.map(({ text }) => text), [
    'The system shall assign a unique claim reference',
    'show the claim status to the claimant.',
  ]);
  assert.equal(split[1].requirementText, 'The system shall show the claim status to the claimant.');
  assert.ok(split.every(({ start, end, text }) => coordinated.slice(start, end) === text));
  const dependent = 'The service shall release a transfer only after fraud checks complete. Otherwise, it must remain blocked.';
  assert.deepEqual(buildRequirementCandidates(dependent, 'input-dependent').map(({ text }) => text), [dependent]);
});
