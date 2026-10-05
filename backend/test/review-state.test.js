import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createSdlcAnalysis } from '../src/services/sdlc-agent.js';

test('PostgreSQL review transitions persist source evidence and stale dependent SDLC results', async (t) => {
  const project = (await pool.query(`INSERT INTO projects(name,description,selected_domain,owner_id)
    VALUES('Review state regression fixture','Temporary automated test fixture','Digital Banking',$1) RETURNING id`, ['00000000-0000-4000-8000-000000000001'])).rows[0];
  const projectId = project.id;
  t.after(async () => { await pool.query('DELETE FROM projects WHERE id=$1', [projectId]); });
  const unrelatedProject = (await pool.query(`INSERT INTO projects(name,description,selected_domain,owner_id)
    VALUES('SDLC isolation regression fixture','Temporary automated test fixture','Payments',$1) RETURNING id`, ['00000000-0000-4000-8000-000000000001'])).rows[0];
  t.after(async () => { await pool.query('DELETE FROM projects WHERE id=$1', [unrelatedProject.id]); });
  const originalText = 'Intro. The account service shall display the verification outcome and reason. Outro.';
  const sourceStart = originalText.indexOf('The account service');
  const sourceEvidence = 'The account service shall display the verification outcome and reason.';
  const input = (await pool.query(`INSERT INTO project_inputs(project_id,input_type,title,source,submitted_content,processing_status,created_by)
    VALUES($1,'STAKEHOLDER_STATEMENT','Review fixture input','Automated regression test',$2,'READY',$3) RETURNING id`, [projectId, originalText, '00000000-0000-4000-8000-000000000001'])).rows[0];
  const requirement = (await pool.query(`INSERT INTO candidate_requirements(project_id,source_input_id,requirement_text,requirement_type,source_evidence,source_evidence_start,source_evidence_end,confidence,extraction_status)
    VALUES($1,$2,$3,'FUNCTIONAL',$3,$4,$5,0.95,'COMPLETED') RETURNING id`, [projectId, input.id, sourceEvidence, sourceStart, sourceStart + sourceEvidence.length])).rows[0];
  const unrelatedInput = (await pool.query(`INSERT INTO project_inputs(project_id,input_type,title,source,submitted_content,processing_status,created_by)
    VALUES($1,'STAKEHOLDER_STATEMENT','Isolation fixture input','Automated regression test','A payment instruction shall retain its own source evidence.','READY',$2) RETURNING id`, [unrelatedProject.id, '00000000-0000-4000-8000-000000000001'])).rows[0];
  await pool.query(`INSERT INTO candidate_requirements(project_id,source_input_id,requirement_text,requirement_type,source_evidence,source_evidence_start,source_evidence_end,confidence,extraction_status,review_status)
    VALUES($1,$2,'A payment instruction shall retain its own source evidence.','FUNCTIONAL','A payment instruction shall retain its own source evidence.',0,58,0.95,'COMPLETED','APPROVED')`, [unrelatedProject.id, unrelatedInput.id]);
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const review = async (status, requirementText) => {
    const response = await fetch(`${base}/requirements/${requirement.id}/review`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, ...(requirementText ? { requirementText } : {}) }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.data;
  };
  const explanation = async (_request, options) => {
    options.onProviderUsed({ provider: 'test', model: 'regression-fixture' });
    return JSON.stringify({ relevantFactors: ['requirementStability', 'requirementClarity'] });
  };

  await assert.rejects(createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation }), { code: 'APPROVED_REQUIREMENTS_REQUIRED' });
  const reviewed = await review('REVIEWED');
  assert.equal(reviewed.reviewStatus, 'REVIEWED');
  await assert.rejects(createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation }), { code: 'APPROVED_REQUIREMENTS_REQUIRED' });

  const approved = await review('APPROVED');
  assert.equal(approved.reviewStatus, 'APPROVED');
  const analysis = await createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation });
  assert.deepEqual(analysis.requirementIds, [requirement.id]);
  assert.equal(analysis.isStale, false);

  const modifiedText = 'The account service shall show the verification outcome, pending reason, and next action.';
  const modified = await review('MODIFIED', modifiedText);
  assert.equal(modified.reviewStatus, 'MODIFIED');
  assert.equal(modified.requirementText, modifiedText);
  assert.equal(modified.sourceEvidence, sourceEvidence);
  assert.equal(modified.sourceEvidenceStart, sourceStart);
  assert.equal(modified.sourceEvidenceEnd, sourceStart + sourceEvidence.length);
  const reread = await fetch(`${base}/requirements/${requirement.id}`);
  const rereadRequirement = (await reread.json()).data;
  assert.equal(rereadRequirement.reviewStatus, 'MODIFIED');
  assert.equal(rereadRequirement.requirementText, modifiedText);
  assert.equal(rereadRequirement.sourceEvidence, sourceEvidence);
  assert.equal(rereadRequirement.sourceEvidenceStart, sourceStart);
  assert.equal(rereadRequirement.sourceEvidenceEnd, sourceStart + sourceEvidence.length);
  const staleAfterModify = await fetch(`${base}/projects/${projectId}/sdlc`);
  const modifiedDependency = (await staleAfterModify.json()).data;
  assert.equal(modifiedDependency.id, analysis.id);
  assert.equal(modifiedDependency.isStale, true);
  await assert.rejects(createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation }), { code: 'APPROVED_REQUIREMENTS_REQUIRED' });

  await review('APPROVED');
  const refreshedAnalysis = await createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation });
  assert.deepEqual(refreshedAnalysis.requirementIds, [requirement.id]);
  await review('REJECTED');
  const staleAfterReject = await fetch(`${base}/projects/${projectId}/sdlc`);
  assert.equal((await staleAfterReject.json()).data.isStale, true);
  await assert.rejects(createSdlcAnalysis({ database: pool, projectId, generateOutput: explanation }), { code: 'APPROVED_REQUIREMENTS_REQUIRED' });
});
