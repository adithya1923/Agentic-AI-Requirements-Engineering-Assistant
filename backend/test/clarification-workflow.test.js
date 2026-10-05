import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

test('stakeholder clarification answers persist and refine a linked requirement without replacing source evidence', async (t) => {
  const projectId = (await pool.query(`INSERT INTO projects(name,description,selected_domain,owner_id)
    VALUES('Clarification workflow fixture','Temporary automated test fixture','Digital Banking',$1) RETURNING id`, ['00000000-0000-4000-8000-000000000001'])).rows[0].id;
  t.after(async () => { await pool.query('DELETE FROM projects WHERE id=$1', [projectId]); });
  const original = 'The service shall send a verification notice.';
  const inputId = (await pool.query(`INSERT INTO project_inputs(project_id,input_type,title,source,submitted_content,processing_status,created_by)
    VALUES($1,'STAKEHOLDER_STATEMENT','Clarification fixture','Automated test',$2,'READY',$3) RETURNING id`, [projectId, original, '00000000-0000-4000-8000-000000000001'])).rows[0].id;
  const requirementId = (await pool.query(`INSERT INTO candidate_requirements(project_id,source_input_id,requirement_text,requirement_type,source_evidence,source_evidence_start,source_evidence_end,confidence,extraction_status,review_status)
    VALUES($1,$2,$3,'FUNCTIONAL',$3,0,length($3),0.9,'COMPLETED','APPROVED') RETURNING id`, [projectId, inputId, original])).rows[0].id;
  const runId = randomUUID();
  await pool.query(`INSERT INTO requirement_analysis_runs(id,project_id,source_input_id,requirement_ids,status,provider,model_name,requirement_count,finding_count)
    VALUES($1,$2,$3,$4,'COMPLETED','test','fixture',1,1)`, [runId, projectId, inputId, [requirementId]]);
  const findingId = (await pool.query(`INSERT INTO requirement_analysis_findings(analysis_run_id,requirement_ids,agent_names,finding_type,severity,title,description,evidence,clarification_question,confidence)
    VALUES($1,$2,ARRAY['Requirements Intelligence Agent'],'INCOMPLETENESS','MEDIUM','Notice timing','The triggering event is unspecified.','[]'::jsonb,'When should the verification notice be sent?',0.9) RETURNING id`, [runId, [requirementId]])).rows[0].id;
  const analysis = await pool.query(`INSERT INTO sdlc_analyses(project_id,factors,ranking,recommendation,explanation,workflow,artefacts,requirement_ids,provider,model_name)
    VALUES($1,'{}'::jsonb,'[]'::jsonb,'AGILE','fixture','[]'::jsonb,'[]'::jsonb,$2,'test','fixture') RETURNING id`, [projectId, [requirementId]]);
  const promptCalls = [];
  const app = createApp({ database: pool, generateOutput: async (request, options) => {
    promptCalls.push(request);
    options.onProviderUsed({ provider: 'test', model: 'clarification-refiner' });
    return JSON.stringify({ requirementText: 'The service shall send a verification notice after the customer submits the verification request.' });
  } });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const body = { findingId, analysisRunId: runId, requirementIds: [requirementId], question: 'When should the verification notice be sent?', answer: 'After the customer submits the verification request.' };
  const savedResponse = await fetch(`${base}/projects/${projectId}/clarification-answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(savedResponse.status, 201);
  const saved = (await savedResponse.json()).data;
  const reread = await fetch(`${base}/projects/${projectId}/clarification-answers`);
  assert.equal((await reread.json()).data[0].answer, body.answer);
  assert.equal(saved.question, body.question);

  const refinedResponse = await fetch(`${base}/projects/${projectId}/requirements/${requirementId}/refine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answerId: saved.id }) });
  assert.equal(refinedResponse.status, 200);
  const refined = (await refinedResponse.json()).data;
  assert.match(promptCalls[0].userPrompt, /After the customer submits the verification request/);
  assert.equal(refined.review_status, 'MODIFIED');
  assert.equal(refined.source_evidence, original);
  assert.equal(refined.source_evidence_start, 0);
  assert.equal(refined.source_evidence_end, original.length);
  assert.equal((await pool.query('SELECT is_stale FROM sdlc_analyses WHERE id=$1', [analysis.rows[0].id])).rows[0].is_stale, true);
});
