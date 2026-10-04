import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { pool } from '../src/db/pool.js';

const projectId='00000000-0000-4000-8000-000000000003';

after(async()=>{await pool.end();});

test('demo seed is idempotent and contains the required READY financial inputs and demo KB corpus',()=>{
  for(let i=0;i<2;i++) execFileSync(process.execPath,['scripts/seed-demo.js'],{cwd:process.cwd(),stdio:'pipe'});
  return pool.query(`SELECT
    (SELECT count(*)::int FROM projects WHERE id=$1) AS projects,
    (SELECT count(*)::int FROM project_inputs WHERE project_id=$1 AND processing_status='READY') AS ready_inputs,
    (SELECT count(*)::int FROM knowledge_documents WHERE id=ANY($2::uuid[]) AND processing_status='READY') AS demo_documents,
    (SELECT count(*)::int FROM knowledge_chunks WHERE knowledge_document_id=ANY($2::uuid[])) AS demo_chunks`,[projectId,['00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022']]).then(({rows})=>{
    assert.deepEqual(rows[0],{projects:1,ready_inputs:7,demo_documents:2,demo_chunks:2});
  });
});
