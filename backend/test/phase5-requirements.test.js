import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { LlmGenerationError } from '../src/services/llm-generation.js';

let server;
let baseUrl;
let projectId;
let otherProjectId;
let textInputId;
let documentInputId;
let nextOutput;
let nextProviderError;
const generationCalls = [];

const sourceText = 'The portal shall show transaction status to the customer. Assume all timestamps use UTC. The service must retain the status history for 90 days with HIGH priority.';
const requirement = (overrides = {}) => ({
  requirementText: 'The portal shall show transaction status to the customer.',
  requirementType: 'FUNCTIONAL',
  priority: null,
  sourceEvidence: 'The portal shall show transaction status to the customer.',
  confidence: 0.94,
  assumptions: [],
  ...overrides,
});

function validResponse(requirements = [requirement()]) {
  return JSON.stringify({ requirements });
}

async function createProject(name) {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).data.id;
}

async function createTextInput(id, content = sourceText) {
  const response = await fetch(`${baseUrl}/projects/${id}/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Phase 5 source', source: 'Test stakeholder', inputType: 'STAKEHOLDER_STATEMENT', content }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).data.id;
}

async function extract(project, input) {
  return fetch(`${baseUrl}/projects/${project}/requirements/extract`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputId: input }),
  });
}

before(async () => {
  const app = createApp({
    generateOutput: async (request) => {
      generationCalls.push(request);
      if (nextProviderError) throw nextProviderError;
      return nextOutput;
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  projectId = await createProject(`Phase 5 extraction ${crypto.randomUUID()}`);
  otherProjectId = await createProject(`Phase 5 other ${crypto.randomUUID()}`);
  textInputId = await createTextInput(projectId);

  const form = new FormData();
  form.set('title', 'Extractable TXT source');
  form.set('source', 'Test project document');
  form.set('file', new Blob(['A loan application shall show its review status.'], { type: 'text/plain' }), 'source.txt');
  const documentResponse = await fetch(`${baseUrl}/projects/${projectId}/inputs/documents`, { method: 'POST', body: form });
  assert.equal(documentResponse.status, 201, await documentResponse.clone().text());
  documentInputId = (await documentResponse.json()).data.id;
});

after(async () => {
  if (projectId) {
    const { rows } = await pool.query('SELECT storage_key FROM project_inputs WHERE project_id=ANY($1::uuid[]) AND storage_key IS NOT NULL', [[projectId, otherProjectId]]);
    for (const row of rows) await fs.rm(path.join(config.uploadDirectory, row.storage_key), { force: true });
    await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [[projectId, otherProjectId]]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('extracts structured candidates, persists evidence offsets, and exposes API traceability', async () => {
  nextOutput = validResponse([requirement(), requirement({
    requirementText: 'The service must retain the status history for 90 days.',
    requirementType: 'CONSTRAINT', priority: 'HIGH',
    sourceEvidence: 'The service must retain the status history for 90 days with HIGH priority.',
    confidence: 0.88, assumptions: ['Assume all timestamps use UTC.'],
  })]);
  const response = await extract(projectId, textInputId);
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.sourceInput.id, textInputId);
  assert.equal(body.requirements.length, 2);
  assert.equal(body.requirements[0].projectId, projectId);
  assert.equal(body.requirements[0].sourceInputId, textInputId);
  assert.equal(body.requirements[0].extractionStatus, 'COMPLETED');
  assert.equal(body.requirements[0].sourceEvidenceStart, sourceText.indexOf(body.requirements[0].sourceEvidence));
  assert.equal(body.requirements[0].sourceEvidenceEnd, body.requirements[0].sourceEvidenceStart + body.requirements[0].sourceEvidence.length);
  assert.equal(body.requirements[1].priority, 'HIGH');
  assert.equal(body.requirements[1].assumptions.length, 1);

  const listResponse = await fetch(`${baseUrl}/projects/${projectId}/requirements`);
  const listed = (await listResponse.json()).data;
  assert.equal(listed.length, 2);
  assert.equal(listed[0].sourceInput.title, 'Phase 5 source');
  const detailResponse = await fetch(`${baseUrl}/requirements/${body.requirements[0].id}`);
  const detail = (await detailResponse.json()).data;
  assert.equal(detail.sourceInput.id, textInputId);
  assert.equal(detail.sourceEvidence, body.requirements[0].sourceEvidence);
});

test('maps whitespace-normalized model evidence back to the exact source slice and offsets', async () => {
  const rawEvidence = 'The portal shall show transaction status to the customer.\nAssume all timestamps use UTC.';
  nextOutput = validResponse([requirement({
    requirementText: 'The portal shall show transaction status to the customer.',
    sourceEvidence: rawEvidence,
  })]);
  const response = await extract(projectId, textInputId);
  assert.equal(response.status, 200);
  const saved = (await response.json()).data.requirements[0];
  const canonicalEvidence = 'The portal shall show transaction status to the customer. Assume all timestamps use UTC.';
  assert.equal(saved.sourceEvidence, canonicalEvidence);
  assert.equal(saved.sourceEvidenceStart, sourceText.indexOf(canonicalEvidence));
  assert.equal(saved.sourceEvidenceEnd, saved.sourceEvidenceStart + canonicalEvidence.length);
  assert.equal(sourceText.slice(saved.sourceEvidenceStart, saved.sourceEvidenceEnd), saved.sourceEvidence);
});

test('uses Phase 3 extracted document text and includes financial project context in the prompt', async () => {
  nextOutput = validResponse([requirement({
    requirementText: 'A loan application shall show its review status.',
    sourceEvidence: 'A loan application shall show its review status.',
  })]);
  const previousCallCount = generationCalls.length;
  const response = await extract(projectId, documentInputId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.sourceInput.inputType, 'DOCUMENT');
  const call = generationCalls[previousCallCount];
  assert.match(call.userPrompt, /A loan application shall show its review status\./);
  assert.ok(call.responseSchema.properties.requirements);
  assert.equal(call.modelPurpose, 'requirement-extraction');
});

test('a successful repeat replaces prior candidates for that input instead of duplicating them', async () => {
  const before = (await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json()).data
    .filter((item) => item.sourceInputId === textInputId);
  nextOutput = validResponse([requirement({ requirementText: 'The portal must display customer transaction status.' })]);
  const response = await extract(projectId, textInputId);
  assert.equal(response.status, 200);
  const created = (await response.json()).data.requirements;
  assert.equal(created.length, 1);
  assert.notEqual(created[0].id, before[0].id);
  const after = (await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json()).data
    .filter((item) => item.sourceInputId === textInputId);
  assert.equal(after.length, 1);
});

test('invalid JSON, type, confidence, and unsupported evidence fail safely without replacing prior candidates', async () => {
  const prior = await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json();
  const priorIds = prior.data.map((item) => item.id);
  const invalidOutputs = [
    '{not json',
    validResponse([requirement({ requirementType: 'REGULATORY_DECISION' })]),
    validResponse([requirement({ confidence: 1.2 })]),
    validResponse([requirement({ sourceEvidence: 'Not present in the source.' })]),
    validResponse([requirement({ priority: 'HIGH' })]),
    validResponse([requirement({ assumptions: ['The system supports biometric authentication.'] })]),
    JSON.stringify({ requirements: [], unexpected: true }),
  ];
  for (const output of invalidOutputs) {
    nextOutput = output;
    const response = await extract(projectId, textInputId);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'INVALID_MODEL_OUTPUT');
    const after = await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json();
    assert.deepEqual(new Set(after.data.map((item) => item.id)), new Set(priorIds));
  }
});

test('an empty valid extraction replaces previous candidates with an empty result', async () => {
  nextOutput = validResponse([]);
  const response = await extract(projectId, textInputId);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.requirements, []);
  const remaining = (await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json()).data;
  assert.equal(remaining.some((item) => item.sourceInputId === textInputId), false);
});

test('rejects non-READY inputs and inputs belonging to a different project', async () => {
  const mismatch = await extract(otherProjectId, textInputId);
  assert.equal(mismatch.status, 404);
  assert.equal((await mismatch.json()).error.code, 'INPUT_NOT_FOUND');

  await pool.query("UPDATE project_inputs SET processing_status='PROCESSING' WHERE id=$1", [textInputId]);
  try {
    const notReady = await extract(projectId, textInputId);
    assert.equal(notReady.status, 409);
    assert.equal((await notReady.json()).error.code, 'INPUT_NOT_READY');
  } finally {
    await pool.query("UPDATE project_inputs SET processing_status='READY' WHERE id=$1", [textInputId]);
  }
});

test('provider timeout/failure returns a safe error and leaves stored candidates intact', async () => {
  nextOutput = validResponse([requirement()]);
  await extract(projectId, textInputId);
  const before = (await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json()).data;
  nextProviderError = new LlmGenerationError('The configured LLM provider timed out.', 'LLM_TIMEOUT', 504);
  try {
    const response = await extract(projectId, textInputId);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'LLM_TIMEOUT');
  } finally {
    nextProviderError = null;
  }
  const afterFailure = (await (await fetch(`${baseUrl}/projects/${projectId}/requirements`)).json()).data;
  assert.deepEqual(afterFailure.map((item) => item.id), before.map((item) => item.id));
});

test('requires a valid source input ID and reports missing projects safely', async () => {
  const invalid = await fetch(`${baseUrl}/projects/${projectId}/requirements/extract`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputId: 'invalid' }),
  });
  assert.equal(invalid.status, 400);
  const missing = await extract('00000000-0000-4000-8000-000000000099', textInputId);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'PROJECT_NOT_FOUND');
});
