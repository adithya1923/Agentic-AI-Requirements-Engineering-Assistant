import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { LlmGenerationError } from '../src/services/llm-generation.js';
import { createRequirementAnalysisService } from '../src/services/requirement-analysis.js';
import { buildRequirementCandidates, validateRequirementOutput } from '../src/services/requirement-extraction.js';
import { config } from '../src/config.js';

let server, baseUrl, projectId, inputId;
let calls = 0, failProvider = false, malformed = false, nextRawOutput = null, nextRawStage = 'analysis', lastRequests = [];
const source = 'The platform should approve every loan after a manager reviews it, but no loan may be approved until two managers have approved it. Users should authenticate securely. Keep customer records for an appropriate period. The system should be fast.';
const citationChunkId='00000000-0000-4000-8000-000000000099';
const citationChunkText='Retention policy control: customer records require a defined retention period and deletion.';

function outputFor(request) {
  const context = JSON.parse(request.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  const kb = context.retrievedKnowledge?.[0];
  return JSON.stringify({
    requirements: [
      { key:'N1', requirementText:'The platform should approve every loan after a manager reviews it,', requirementType:'BUSINESS_RULE', priority:null, sourceEvidence:'The platform should approve every loan after a manager reviews it,', confidence:0.94, assumptions:[] },
      { key:'N2', requirementText:'no loan may be approved until two managers have approved it.', requirementType:'BUSINESS_RULE', priority:null, sourceEvidence:'no loan may be approved until two managers have approved it.', confidence:0.92, assumptions:[] },
      { key:'N3', requirementText:'Users should authenticate securely.', requirementType:'NON_FUNCTIONAL', priority:null, sourceEvidence:'Users should authenticate securely.', confidence:0.89, assumptions:[] },
      { key:'N4', requirementText:'Keep customer records for an appropriate period.', requirementType:'CONSTRAINT', priority:null, sourceEvidence:'Keep customer records for an appropriate period.', confidence:0.88, assumptions:[] },
      { key:'N5', requirementText:'The system should be fast.', requirementType:'NON_FUNCTIONAL', priority:null, sourceEvidence:'The system should be fast.', confidence:0.84, assumptions:[] },
    ],
    findings:[{ findingType:'CONFLICT',severity:'HIGH',title:'Loan approval rules conflict',description:'The first statement permits approval after one manager review while the second requires two approvals.',requirementIds:['N1','N2'],clarificationQuestion:'Should one manager review or two manager approvals be required?',confidence:0.95 },
      { findingType:'CONSISTENCY',severity:'HIGH',title:'Approval conditions need reconciliation',description:'The two approval conditions cannot both govern the same loan in the stated way.',requirementIds:['N1','N2'],clarificationQuestion:null,confidence:0.91 },
      { findingType:'AMBIGUITY',severity:'MEDIUM',title:'Authentication is underspecified',description:'The method and strength of authentication are not stated.',requirementIds:['N3'],clarificationQuestion:'Which authentication methods and assurance level are required?',confidence:0.91 },
      { findingType:'INCOMPLETENESS',severity:'MEDIUM',title:'Retention period is missing',description:'The duration and deletion rules are not defined.',requirementIds:['N4'],clarificationQuestion:'What retention period and deletion rules apply?',confidence:0.9 },
      { findingType:'QUALITY',severity:'LOW',title:'Performance target is not testable',description:'Fast does not define an observable response-time target.',requirementIds:['N5'],clarificationQuestion:null,confidence:0.79 },
      { findingType:'CLASSIFICATION',severity:'INFO',title:'Retention candidate type can be reviewed',description:'The retention statement may be a business constraint rather than a functional behavior.',requirementIds:['N4'],clarificationQuestion:null,confidence:0.74 }],
    securityPrivacy:[{category:'SECURITY',title:'Authentication details need definition',observation:'Specify authentication method and account recovery expectations.',requirementKeys:['N3'],confidence:0.86}],
    risks:[{title:'Undefined retention could create operational risk',observation:'Unspecified retention can make lifecycle behavior difficult to implement and verify.',requirementKeys:['N4'],confidence:0.8}],
    complianceMappings: kb ? [{title:'Retention policy topic',observation:'The demo control note identifies retention and deletion rules as topics for project review; it is not an official requirement.',requirementKeys:['N4'],knowledgeChunkId:kb.chunkId,confidence:0.76}] : [],
  });
}

function requirementOnlyOutputFor(request) {
  const output=JSON.parse(outputFor(request));
  const context=JSON.parse(request.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  return JSON.stringify({requirements:output.requirements.map(({requirementText,requirementType,confidence})=>{
    const candidate=context.candidates.find((entry)=>entry.text===requirementText);
    assert.ok(candidate,`test fixture requirement has no exact source candidate: ${requirementText}`);
    return {candidateId:candidate.candidateId,requirementType,confidence};
  })});
}
function analysisOnlyOutputFor(request) {
  const output=JSON.parse(outputFor(request));
  const conflict=output.findings.find((finding)=>finding.findingType==='CONFLICT');
  const findings=[
    ...conflict.requirementIds.map((requirementId)=>({requirementId,findingType:conflict.findingType,description:conflict.description,severity:conflict.severity,clarificationQuestion:conflict.clarificationQuestion})),
    ...output.findings.filter((finding)=>!['CONFLICT','CONSISTENCY'].includes(finding.findingType)).map(({requirementIds,...finding})=>({requirementId:requirementIds[0],findingType:finding.findingType,description:finding.description,severity:finding.severity,clarificationQuestion:finding.clarificationQuestion})),
  ];
  return JSON.stringify({findings});
}
function runWithKnowledge() {
  const database={
    query:(sql,params)=>sql.includes('FROM knowledge_chunks c')?Promise.resolve({rows:[{chunk_id:citationChunkId,document_id:'00000000-0000-4000-8000-000000000098',title:'Citation fixture',source:'Test source',authority:null,tags:[],chunk_text:citationChunkText,similarity:0.9}]}):pool.query(sql,params),
    connect:()=>pool.connect(),
  };
  return createRequirementAnalysisService({database,embedQuery:async()=>Array(768).fill(0.01),generateOutput:async(request)=>request.responseSchema.required.includes('requirements')?requirementOnlyOutputFor(request):analysisOnlyOutputFor(request)})(projectId,inputId);
}
function extractionResult(sourceText, requirementText, priority=null, assumptions) {
  const requirement={requirementText,requirementType:'FUNCTIONAL',priority,confidence:0.9};
  if(assumptions!==undefined)requirement.assumptions=assumptions;
  return validateRequirementOutput(JSON.stringify({requirements:[requirement]}),sourceText)[0];
}

test('Call 1 derives exact authoritative evidence and offsets from requirementText',()=>{
  const sourceText='The applicant must provide supporting documents.';
  const requirement=extractionResult(sourceText,sourceText);
  assert.equal(requirement.sourceEvidence,sourceText);
  assert.equal(sourceText.slice(requirement.sourceEvidenceStart,requirement.sourceEvidenceEnd),sourceText);
});

test('Call 1 accepts whitespace-only source differences and preserves the original source span',()=>{
  const sourceText='The applicant must provide\n\n supporting documents.';
  const requirement=extractionResult(sourceText,'The applicant must provide supporting documents.');
  assert.equal(requirement.sourceEvidence,sourceText);
  assert.equal(sourceText.slice(requirement.sourceEvidenceStart,requirement.sourceEvidenceEnd),sourceText);
});

test('Call 1 rejects paraphrased requirementText that cannot be located in the source',()=>{
  assert.throws(()=>extractionResult('Applicants can upload supporting documents.','Applicants may attach files.'),(error)=>error.diagnosticReason==='SOURCE_EVIDENCE_NOT_FOUND'&&error.diagnosticDetail.field==='requirementText');
});

test('Call 1 normalizes unsupported inferred priorities and preserves explicitly supported priority',()=>{
  const text='The system stores the submitted application.';
  for(const priority of ['HIGH','MEDIUM','LOW','URGENT',100]) assert.equal(extractionResult(text,text,priority).priority,'UNKNOWN');
  const omittedPriority=validateRequirementOutput(JSON.stringify({requirements:[{requirementText:text,requirementType:'FUNCTIONAL',confidence:0.9}]}),text)[0];
  assert.equal(omittedPriority.priority,'UNKNOWN');
  const explicitlyPrioritized='The system stores the application with HIGH priority.';
  assert.equal(extractionResult(explicitlyPrioritized,explicitlyPrioritized,'HIGH').priority,'HIGH');
});

test('Call 1 defaults missing or empty assumptions and retains only verbatim source-grounded assumptions',()=>{
  const sourceText='The portal shall show account status. Assume timestamps use UTC.';
  assert.deepEqual(extractionResult(sourceText,'The portal shall show account status.').assumptions,[]);
  assert.deepEqual(extractionResult(sourceText,'The portal shall show account status.',null,[]).assumptions,[]);
  assert.deepEqual(extractionResult(sourceText,'The portal shall show account status.',null,['Assume timestamps use UTC.']).assumptions,['Assume timestamps use UTC.']);
  assert.deepEqual(extractionResult(sourceText,'The portal shall show account status.',null,['Assume all times use GMT.']).assumptions,[]);
  const malformedAssumptions=validateRequirementOutput(JSON.stringify({requirements:[{requirementText:'The portal shall show account status.',requirementType:'FUNCTIONAL',confidence:0.9,assumptions:{inferred:'UTC'}}]}),sourceText)[0];
  assert.deepEqual(malformedAssumptions.assumptions,[]);
});

test('candidate generation keeps exact source spans and stays bounded',()=>{
  const inputIdForCandidates='source-input-candidates';
  const candidateSource='First requirement.\r\nSecond requirement, but a separate conflicting clause.\nThird requirement.';
  const candidates=buildRequirementCandidates(candidateSource,inputIdForCandidates);
  assert.deepEqual(candidates.map(({text})=>text),['First requirement.','Second requirement,','a separate conflicting clause.','Third requirement.']);
  for(const candidate of candidates){
    assert.equal(candidate.sourceInputId,inputIdForCandidates);
    assert.equal(candidateSource.slice(candidate.start,candidate.end),candidate.text);
  }
  const many=Array.from({length:500},(_,index)=>`Requirement ${index+1} is stated here.`).join('\n');
  const bounded=buildRequirementCandidates(many,inputIdForCandidates);
  assert.ok(bounded.length<=80);
  assert.ok(bounded.every(({start,end,text})=>many.slice(start,end)===text));
});

before(async () => {
  const app=createApp({embedQuery:async()=>Array(768).fill(0.01),generateOutput:async(request,options={})=>{
    calls+=1;
    lastRequests.push(request);
    assert.equal(options.provider,config.generation.provider); assert.deepEqual(options.fallbacks,[]); assert.equal(options.retryAttempts,1);
    if(failProvider) throw new LlmGenerationError('LLM provider is temporarily unavailable.','LLM_PROVIDER_UNAVAILABLE',503);
    options.onProviderUsed?.({provider:'test-provider',model:'test-model'});
    if(malformed)return '{bad json';
    const stage=request.responseSchema.required.includes('requirements')?'requirements':'analysis';
    if(nextRawOutput&&(nextRawStage===stage||nextRawStage==='both'))return typeof nextRawOutput==='function'?nextRawOutput(request,stage):nextRawOutput;
    return stage==='requirements'?requirementOnlyOutputFor(request):analysisOnlyOutputFor(request);
  }});
  server=app.listen(0,'127.0.0.1'); await new Promise((resolve)=>server.once('listening',resolve));
  baseUrl=`http://127.0.0.1:${server.address().port}/api`;
  const projectResponse=await fetch(`${baseUrl}/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:`Requirements intelligence ${crypto.randomUUID()}`})});
  projectId=(await projectResponse.json()).data.id;
  const inputResponse=await fetch(`${baseUrl}/projects/${projectId}/inputs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Problem requirements',source:'Integration fixture',inputType:'INTERVIEW_TRANSCRIPT',content:source})});
  inputId=(await inputResponse.json()).data.id;
});

after(async()=>{ if(projectId) await pool.query('DELETE FROM projects WHERE id=$1',[projectId]); await new Promise((resolve)=>server.close(resolve)); await pool.end(); });

async function run() { return fetch(`${baseUrl}/projects/${projectId}/requirements/intelligence`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inputId})}); }

test('two structured calls extract and analyze requirements with persisted IDs, evidence, confidence and citations',async()=>{
  calls=0; lastRequests=[]; const beforeInput=(await pool.query('SELECT submitted_content FROM project_inputs WHERE id=$1',[inputId])).rows[0].submitted_content;
  const response=await run(); assert.equal(response.status,200,await response.clone().text());
  const data=(await response.json()).data; assert.equal(calls,2); assert.equal(data.provider,'test-provider'); assert.equal(data.requirements.length,5);
  const [extractionRequest,analysisRequest]=lastRequests;
  assert.deepEqual(extractionRequest.responseSchema.required,['requirements']);
  assert.ok(extractionRequest.responseSchema.properties.requirements); assert.equal(extractionRequest.ollamaFormat,undefined);
  const extractedItemSchema=extractionRequest.responseSchema.properties.requirements.items;
  assert.deepEqual(extractedItemSchema.required,['candidateId','requirementType','confidence']);
  assert.ok(extractedItemSchema.properties.candidateId);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'key'),false);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'requirementText'),false);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'sourceEvidence'),false);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'sourceEvidenceStart'),false);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'priority'),false);
  assert.equal(Object.hasOwn(extractedItemSchema.properties,'assumptions'),false);
  assert.ok(extractionRequest.systemPrompt.includes('Return only each selected candidateId, its requirementType, and confidence'));
  assert.ok(extractionRequest.systemPrompt.includes('Do not return requirementText, sourceEvidence, offsets, canonical requirement IDs, priority, or assumptions'));
  assert.deepEqual(analysisRequest.responseSchema.required,['findings']);
  const findingSchema=analysisRequest.responseSchema.properties.findings.items;
  assert.deepEqual(Object.keys(findingSchema.properties),['requirementId','findingType','description','severity','clarificationQuestion']);
  assert.deepEqual(findingSchema.required,['requirementId','findingType','description','severity','clarificationQuestion']);
  assert.equal(analysisRequest.ollamaFormat,undefined);
  for(const scaleText of ['decimal JSON number from 0.0 to 1.0','NEVER a percentage','100% = 1.0','90% = 0.9','75% = 0.75','0.0, 0.5, 0.85, 0.95, 1.0','50, 75, 90, 100']) assert.ok(extractionRequest.systemPrompt.includes(scaleText));
  assert.match(extractionRequest.responseSchema.properties.requirements.items.properties.confidence.description,/decimal number from 0\.0 to 1\.0, never a percentage/i);
  for(const instruction of ['identify meaningful source-supported quality, security, privacy, risk, compliance, and clarification issues','Return a single flat findings array','requirementId, findingType, description, severity, and clarificationQuestion','Do not return titles, requirement text, evidence, confidence, offsets, nested objects']) assert.ok(analysisRequest.systemPrompt.includes(instruction),instruction);
  const analysisContext=JSON.parse(analysisRequest.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  assert.equal(Object.hasOwn(analysisContext,'existingRequirements'),false);
  const extractionContext=JSON.parse(extractionRequest.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  assert.equal(Object.hasOwn(extractionContext,'existingRequirements'),false);
  assert.equal(Object.hasOwn(extractionContext.input,'text'),false);
  assert.equal(extractionContext.candidates.length,5);
  assert.ok(extractionContext.candidates.every((candidate)=>source.includes(candidate.text)));
  assert.deepEqual(analysisContext.requirements.map((requirement)=>requirement.key),['N1','N2','N3','N4','N5']);
  assert.ok(analysisContext.input.text.includes('two managers have approved it'));
  assert.ok(data.requirements.every((r)=>r.id&&r.sourceInputId===inputId&&r.confidence>=0&&r.confidence<=1&&source.slice(r.sourceEvidenceStart,r.sourceEvidenceEnd)===r.sourceEvidence));
  const conflict=data.findings.find((f)=>f.findingType==='CONFLICT'); assert.equal(conflict.requirementIds.length,2); assert.ok(conflict.requirementIds.every((id)=>data.requirements.some((r)=>r.id===id)));
  const singleRequirementFinding=data.findings.find((finding)=>finding.findingType==='AMBIGUITY'); assert.equal(singleRequirementFinding.requirementIds.length,1); assert.equal(singleRequirementFinding.requirementIds[0],data.requirements[2].id);
  assert.deepEqual(conflict.evidence,conflict.requirementIds.map((requirementId)=>({requirementId,quote:data.requirements.find((requirement)=>requirement.id===requirementId).sourceEvidence})));
  assert.equal(data.analysis.summary.clarificationQuestions.length,3);
  for(const type of ['AMBIGUITY','INCOMPLETENESS','QUALITY','CONFLICT','CLASSIFICATION']) assert.ok(data.analysis.summary.findingsByType[type]>=1);
  assert.equal(data.findings.length,5);
  const intelligence=data.analysis.summary.intelligence; assert.equal(intelligence.securityPrivacy.length,1); assert.equal(intelligence.risks.length,1);
  assert.equal(intelligence.securityPrivacy[0].evidenceQuote,data.requirements.find((requirement)=>requirement.id===intelligence.securityPrivacy[0].requirementIds[0]).sourceEvidence);
  assert.equal(intelligence.risks[0].evidenceQuote,data.requirements.find((requirement)=>requirement.id===intelligence.risks[0].requirementIds[0]).sourceEvidence);
  assert.ok(intelligence.complianceMappings.length<=1);
  assert.ok(intelligence.complianceMappings.every((mapping)=>mapping.citation&&mapping.evidenceQuote===mapping.citation.text));
  assert.equal((await pool.query('SELECT submitted_content FROM project_inputs WHERE id=$1',[inputId])).rows[0].submitted_content,beforeInput);
  const persisted=await pool.query('SELECT provider,model_name,requirement_count,finding_count,summary FROM requirement_analysis_runs WHERE id=$1',[data.analysis.id]);
  assert.equal(persisted.rows.length,1); assert.equal(persisted.rows[0].requirement_count,5); assert.equal(persisted.rows[0].finding_count,5); assert.ok(persisted.rows[0].summary.intelligence.risks.length);
  const persistedFinding=await pool.query('SELECT evidence FROM requirement_analysis_findings WHERE id=$1',[conflict.id]);
  assert.deepEqual(persistedFinding.rows[0].evidence,conflict.evidence);
});

test('persists and retrieves independent source-scoped requirements and analyses without project-wide context leakage',async()=>{
  const sourceB='The fraud service shall inspect each transaction before settlement.';
  const inputResponse=await fetch(`${baseUrl}/projects/${projectId}/inputs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Fraud source B',source:'Integration fixture',inputType:'STAKEHOLDER_STATEMENT',content:sourceB})});
  assert.equal(inputResponse.status,201);
  const sourceBId=(await inputResponse.json()).data.id;
  const priorB=await fetch(`${baseUrl}/projects/${projectId}/requirements/analysis?sourceInputId=${sourceBId}`);
  assert.equal(priorB.status,200);
  assert.equal((await priorB.json()).data.analysis,null,'source B must not fall back to source A analysis');
  nextRawOutput=(request,stage)=>{
    const context=JSON.parse(request.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    if(stage==='requirements')return JSON.stringify({requirements:[{candidateId:context.candidates[0].candidateId,requirementType:'FUNCTIONAL',confidence:0.9}]});
    return JSON.stringify({findings:[
      {requirementId:'N1',findingType:'QUALITY',description:'A source-specific review is needed.',severity:'LOW',clarificationQuestion:null},
      {requirementId:dataFromPriorRun.findingRequirementId,findingType:'AMBIGUITY',description:'Cross-source reference must be discarded.',severity:'MEDIUM',clarificationQuestion:null},
    ]});
  };
  const sourceAResponse=await fetch(`${baseUrl}/projects/${projectId}/requirements/analysis?sourceInputId=${inputId}`);
  const sourceAData=(await sourceAResponse.json()).data;
  const dataFromPriorRun={findingRequirementId:sourceAData.findings[0]?.requirementIds[0]||'foreign-requirement-id'};
  nextRawStage='both'; lastRequests=[];
  try {
    const result=await fetch(`${baseUrl}/projects/${projectId}/requirements/intelligence`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({inputId:sourceBId})});
    assert.equal(result.status,200,await result.clone().text());
    const body=(await result.json()).data;
    assert.equal(body.sourceInputId,sourceBId);
    assert.equal(body.requirements.length,1);
    assert.equal(body.requirements[0].sourceInputId,sourceBId);
    assert.equal(body.analysis.sourceInputId,sourceBId);
    assert.equal(body.analysis.requirementCount,1);
    assert.equal(body.findings.length,1);
    assert.deepEqual(body.findings[0].requirementIds,[body.requirements[0].id]);
    const context=JSON.parse(lastRequests[1].userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    assert.deepEqual(context.requirements.map((requirement)=>requirement.key),['N1']);
    const requirementsA=await fetch(`${baseUrl}/projects/${projectId}/requirements?sourceInputId=${inputId}`);
    const requirementsB=await fetch(`${baseUrl}/projects/${projectId}/requirements?sourceInputId=${sourceBId}`);
    assert.ok((await requirementsA.json()).data.every((requirement)=>requirement.sourceInputId===inputId));
    assert.ok((await requirementsB.json()).data.every((requirement)=>requirement.sourceInputId===sourceBId));
    const analysisA=(await (await fetch(`${baseUrl}/projects/${projectId}/requirements/analysis?sourceInputId=${inputId}`)).json()).data;
    const analysisB=(await (await fetch(`${baseUrl}/projects/${projectId}/requirements/analysis?sourceInputId=${sourceBId}`)).json()).data;
    assert.equal(analysisA.sourceInputId,inputId);
    assert.equal(analysisB.sourceInputId,sourceBId);
    assert.notEqual(analysisA.analysis.id,analysisB.analysis.id);
    assert.ok(analysisA.findings.every((finding)=>finding.requirementIds.every((id)=>analysisA.analysis.requirementIds.includes(id))));
    assert.ok(analysisB.findings.every((finding)=>finding.requirementIds.every((id)=>analysisB.analysis.requirementIds.includes(id))));
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('repeat operation replaces selected-input candidates without duplicates',async()=>{
  const before=(await pool.query('SELECT count(*)::int AS n FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2',[projectId,inputId])).rows[0].n;
  assert.equal(before,5); const response=await run(); assert.equal(response.status,200); const afterCount=(await pool.query('SELECT count(*)::int AS n FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2',[projectId,inputId])).rows[0].n; assert.equal(afterCount,5);
});

test('candidate IDs produce exact backend-owned requirements and duplicate selections are deduplicated',async()=>{
  nextRawOutput=(request,stage)=>{
    if(stage==='analysis')return JSON.stringify({findings:[]});
    const selections=JSON.parse(requirementOnlyOutputFor(request)).requirements;
    return JSON.stringify({requirements:[...selections.slice(0,4),selections[0]]});
  };
  nextRawStage='both'; lastRequests=[];
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    const extractionContext=JSON.parse(lastRequests[0].userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    const analysisContext=JSON.parse(lastRequests[1].userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    assert.deepEqual(analysisContext.requirements.map((requirement)=>requirement.key),['N1','N2','N3','N4']);
    assert.equal(data.requirements.length,4);
    assert.equal(new Set(data.requirements.map((requirement)=>requirement.requirementText)).size,4);
    assert.deepEqual(data.requirements.map((requirement)=>requirement.requirementText),extractionContext.candidates.slice(0,4).map((candidate)=>candidate.text));
    assert.ok(data.requirements.every((requirement)=>requirement.sourceEvidence===requirement.requirementText&&source.slice(requirement.sourceEvidenceStart,requirement.sourceEvidenceEnd)===requirement.sourceEvidence));
    assert.ok(data.findings.every((finding)=>finding.requirementIds.every((id)=>data.requirements.some((requirement)=>requirement.id===id))));
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('Call 1 rejects unknown candidate IDs without replacing the previous successful result',async()=>{
  const candidate=buildRequirementCandidates(source,inputId)[0];
  const requirementsBefore=(await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id);
  const runBefore=(await pool.query('SELECT id FROM requirement_analysis_runs WHERE project_id=$1',[projectId])).rows[0]?.id;
  nextRawOutput=JSON.stringify({requirements:[{candidateId:`${inputId}:FOREIGN`,requirementType:'FUNCTIONAL',confidence:0.9}]}); nextRawStage='requirements'; calls=0;
  try {
    const response=await run(); assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');
    assert.equal(calls,1);
    assert.equal(candidate.sourceInputId,inputId);
    assert.deepEqual((await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id),requirementsBefore);
    assert.equal((await pool.query('SELECT id FROM requirement_analysis_runs WHERE project_id=$1',[projectId])).rows[0]?.id,runBefore);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('Call 1 rejects model-authored requirement text instead of treating it as authoritative',async()=>{
  const candidate=buildRequirementCandidates(source,inputId)[0];
  nextRawOutput=JSON.stringify({requirements:[{candidateId:candidate.candidateId,requirementType:'FUNCTIONAL',confidence:0.9,requirementText:'Invented text must not enter persistence.'}]}); nextRawStage='requirements'; calls=0;
  try {
    const response=await run(); assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');
    assert.equal(calls,1);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('scopes Call 2 to the selected input and discards findings referencing another source input',async()=>{
  const existingEvidence='The customer portal shall show the account status.';
  const secondaryInputResponse=await fetch(`${baseUrl}/projects/${projectId}/inputs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Existing requirement source',source:'Integration fixture',inputType:'STAKEHOLDER_STATEMENT',content:existingEvidence})});
  assert.equal(secondaryInputResponse.status,201);
  const secondaryInputId=(await secondaryInputResponse.json()).data.id;
  const existingId=(await pool.query(`INSERT INTO candidate_requirements (project_id,source_input_id,requirement_text,requirement_type,source_evidence,source_evidence_start,source_evidence_end,confidence,assumptions) VALUES ($1,$2,$3,'FUNCTIONAL',$3,0,$4,0.9,'{}') RETURNING id`,[projectId,secondaryInputId,existingEvidence,existingEvidence.length])).rows[0].id;
  const generated=JSON.parse(analysisOnlyOutputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  generated.findings[0].requirementId=existingId;
  nextRawOutput=JSON.stringify(generated); nextRawStage='analysis';
  lastRequests=[];
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    assert.ok(data.findings.every((finding)=>finding.requirementIds.every((id)=>data.requirements.some((requirement)=>requirement.id===id))));
    const analysisContext=JSON.parse(lastRequests[1].userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    assert.equal(Object.hasOwn(analysisContext,'existingRequirements'),false);
    assert.deepEqual(analysisContext.requirements.map((requirement)=>requirement.key),['N1','N2','N3','N4','N5']);
    assert.equal(analysisContext.requirements.some((requirement)=>requirement.key===existingId),false);
    assert.equal(data.requirements.length,5);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('constructs and persists compliance mapping only from retrieved knowledge grounded in the selected requirement',async()=>{
  const data=await runWithKnowledge();
  const savedMapping=data.analysis.summary.intelligence.complianceMappings[0];
  assert.equal(data.analysis.status,'COMPLETED');
  assert.deepEqual(savedMapping.requirementIds,[data.requirements[3].id]);
  assert.equal(savedMapping.citation.chunkId,citationChunkId);
  assert.equal(savedMapping.evidenceQuote,citationChunkText);
  const persisted=await pool.query('SELECT summary FROM requirement_analysis_runs WHERE id=$1',[data.analysis.id]);
  assert.equal(persisted.rows.length,1);
  assert.equal(persisted.rows[0].summary.intelligence.complianceMappings[0].citation.chunkId,citationChunkId);
  assert.equal(persisted.rows[0].summary.intelligence.complianceMappings[0].evidenceQuote,citationChunkText);
});

test('Call 2 discards finding references that do not identify canonical or existing requirements',async()=>{
  const analysis=JSON.parse(analysisOnlyOutputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  analysis.findings[0].requirementId='temporary-llm-key';
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis'; calls=0;
  try {
    const response=await run();
    assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    assert.ok(data.findings.every((finding)=>finding.requirementIds.every((id)=>data.requirements.some((requirement)=>requirement.id===id))));
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
  assert.equal(calls,2,'Call 2 reference validation follows successful canonicalization in Call 1');
});

test('Call 2 ignores model requirement text and attaches authoritative text and evidence by requirementId',async()=>{
  const analysis=JSON.parse(analysisOnlyOutputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  const retention=analysis.findings.find((finding)=>finding.requirementId==='N4');
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis';
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    const saved=data.findings.find((finding)=>finding.requirementIds.includes(data.requirements[3].id));
    const authoritative=data.requirements.find((requirement)=>requirement.id===saved.requirementIds[0]);
    assert.equal(authoritative.requirementText,'Keep customer records for an appropriate period.');
    assert.deepEqual(saved.evidence,[{requirementId:authoritative.id,quote:authoritative.sourceEvidence}]);
  }
  finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('Call 2 emits only flat semantic fields and discards malformed or cross-source findings without failing the run',async()=>{
  const requirements=JSON.parse(requirementOnlyOutputFor({userPrompt:`<context>${JSON.stringify({candidates:buildRequirementCandidates(source,inputId).map(({candidateId,text})=>({candidateId,text}))})}</context>`})).requirements;
  const first=buildRequirementCandidates(source,inputId)[0];
  nextRawOutput=(request,stage)=>stage==='requirements'?JSON.stringify({requirements}):JSON.stringify({findings:[
    {requirementId:'N1',findingType:'QUALITY',description:'This criterion is not measurable.',severity:'LOW',clarificationQuestion:{unexpected:true}},
    {requirementId:'foreign-input-requirement',findingType:'AMBIGUITY',description:'Must be discarded.',severity:'MEDIUM',clarificationQuestion:null},
    {requirementId:'N2',findingType:'AMBIGUITY',description:'Valid finding remains.',severity:'MEDIUM',clarificationQuestion:null},
  ]});
  nextRawStage='both';
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    assert.equal(data.findings.length,2);
    const validFinding=data.findings.find((finding)=>finding.description==='Valid finding remains.');
    const malformedClarification=data.findings.find((finding)=>finding.requirementIds[0]===data.requirements[0].id);
    assert.deepEqual(validFinding.evidence,[{requirementId:data.requirements[1].id,quote:data.requirements[1].sourceEvidence}]);
    assert.equal(malformedClarification.clarificationQuestion,null);
    assert.ok(first.candidateId);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('identical clarification questions are persisted only once',async()=>{
  const analysis=JSON.parse(analysisOnlyOutputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  const question=analysis.findings.find((finding)=>finding.clarificationQuestion)?.clarificationQuestion;
  const duplicate=analysis.findings.find((finding)=>!finding.clarificationQuestion);
  assert.ok(question); assert.ok(duplicate);
  duplicate.clarificationQuestion=question;
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis';
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    assert.equal(data.findings.filter((finding)=>finding.clarificationQuestion===question).length,1);
    assert.equal(data.analysis.summary.clarificationQuestions.filter((entry)=>entry.question===question).length,1);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('provider failure and malformed output do not create fake findings or replace saved candidates',async()=>{
  const ids=(await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 ORDER BY id',[projectId])).rows.map((r)=>r.id);
  const previousRun=(await pool.query('SELECT id FROM requirement_analysis_runs WHERE project_id=$1',[projectId])).rows[0];
  const previousFindings=(await pool.query('SELECT id FROM requirement_analysis_findings WHERE analysis_run_id=$1 ORDER BY id',[previousRun.id])).rows.map((row)=>row.id);
  failProvider=true; try {const response=await run();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'LLM_PROVIDER_UNAVAILABLE');} finally {failProvider=false;}
  malformed=true; try {const response=await run();assert.equal(response.status,502);assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');} finally {malformed=false;}
  assert.deepEqual((await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 ORDER BY id',[projectId])).rows.map((r)=>r.id),ids);
  assert.equal((await pool.query('SELECT id FROM requirement_analysis_runs WHERE project_id=$1',[projectId])).rows[0]?.id,previousRun.id);
  assert.deepEqual((await pool.query('SELECT id FROM requirement_analysis_findings WHERE analysis_run_id=$1 ORDER BY id',[previousRun.id])).rows.map((row)=>row.id),previousFindings);
});

test('invalid candidate confidence logs a safe field-specific diagnostic without source text',async()=>{
  const candidate=buildRequirementCandidates(source,inputId)[0];
  const before=(await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id);
  nextRawOutput=JSON.stringify({requirements:[{candidateId:candidate.candidateId,requirementType:'FUNCTIONAL',confidence:'not-a-number'}]}); nextRawStage='requirements'; calls=0; lastRequests=[];
  const originalWarn=console.warn; let diagnostic;
  console.warn=(message,details)=>{if(message==='Requirements Intelligence output rejected.')diagnostic=details;};
  try {
    const response=await run();
    assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');
  } finally { nextRawOutput=null; nextRawStage='analysis'; console.warn=originalWarn; }
  assert.equal(calls,1,'Call 1 validation failure must prevent Call 2');
  assert.deepEqual((await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id),before);
  assert.equal(diagnostic.diagnosticReason,'REQUIREMENT_CANDIDATE_CONFIDENCE');
  assert.deepEqual(diagnostic.diagnosticDetail,{field:'confidence',selectionIndex:0,validationReason:'must be a JSON number from 0 to 1'});
  assert.equal(JSON.stringify(diagnostic).includes(source),false);
});
