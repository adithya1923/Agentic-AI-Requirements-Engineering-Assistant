import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';

const projectIds=Array.from({length:6},(_,index)=>`00000000-0000-4000-8000-${String(101+index).padStart(12,'0')}`);
const knowledgeIds=Array.from({length:10},(_,index)=>`00000000-0000-4000-8000-${String(21+index).padStart(12,'0')}`);

after(async()=>{await pool.end();});

test('domain demo seed is idempotent, project-scoped, and embeds an expanded non-authoritative KB corpus',()=>{
  const inputIds=Array.from({length:24},(_,index)=>`00000000-0000-4000-8000-${String(111+Math.floor(index/4)*10+index%4).padStart(12,'0')}`);
  const existingOutputs=pool.query(`SELECT id,review_status,requirement_text,source_evidence,source_evidence_start,source_evidence_end
    FROM candidate_requirements WHERE project_id=ANY($1::uuid[]) ORDER BY id`,[projectIds]);
  return existingOutputs.then(async(before)=>{
  for(let i=0;i<2;i++) execFileSync(process.execPath,['scripts/seed-demo.js'],{cwd:process.cwd(),stdio:'pipe'});
  const result=await pool.query(`SELECT
    (SELECT count(*)::int FROM projects WHERE id=ANY($1::uuid[])) AS projects,
    (SELECT count(*)::int FROM project_inputs WHERE project_id=ANY($1::uuid[]) AND processing_status='READY') AS ready_inputs,
    (SELECT count(*)::int FROM knowledge_documents WHERE id=ANY($2::uuid[]) AND processing_status='READY') AS demo_documents,
    (SELECT count(*)::int FROM knowledge_chunks WHERE knowledge_document_id=ANY($2::uuid[])) AS demo_chunks,
    (SELECT count(DISTINCT project_id)::int FROM project_inputs WHERE id=ANY($3::uuid[])) AS input_projects,
    (SELECT min(length(submitted_content))::int FROM project_inputs WHERE id=ANY($3::uuid[])) AS smallest_input,
    (SELECT count(*)::int FROM projects WHERE id=$4 AND status='ARCHIVED') AS preserved_legacy`,[projectIds,knowledgeIds,inputIds,'00000000-0000-4000-8000-000000000003']);
  const {rows}=result;
    assert.equal(rows[0].projects,6);
    assert.equal(rows[0].ready_inputs,24);
    assert.equal(rows[0].demo_documents,10);
    assert.equal(rows[0].demo_chunks,20);
    assert.equal(rows[0].input_projects,6);
    assert.ok(rows[0].smallest_input>=2000);
    assert.equal(rows[0].preserved_legacy,1);
    const after=await pool.query(`SELECT id,review_status,requirement_text,source_evidence,source_evidence_start,source_evidence_end
      FROM candidate_requirements WHERE project_id=ANY($1::uuid[]) ORDER BY id`,[projectIds]);
    assert.deepEqual(after.rows,before.rows,'repeated seeding must preserve existing generated/reviewed requirements');
  });
});
