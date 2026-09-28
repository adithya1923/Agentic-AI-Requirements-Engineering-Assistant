import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { LlmGenerationError } from '../src/services/llm-generation.js';
import { createRequirementAnalysisService } from '../src/services/requirement-analysis.js';
import { config } from '../src/config.js';

let server, baseUrl, projectId, inputId;
let calls = 0, failProvider = false, malformed = false, nextRawOutput = null, nextRawStage = 'analysis', lastRequests = [];
const source = 'The platform should approve every loan after a manager reviews it, but no loan may be approved until two managers have approved it. Users should authenticate securely. Keep customer records for an appropriate period. The system should be fast.';
const citationChunkId='00000000-0000-4000-8000-000000000099';
const citationChunkText='Payment control guidance requires a fraud screening review before funds settlement, followed by transaction logging.';

function outputFor(request) {
  const context = JSON.parse(request.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  const kb = context.retrievedKnowledge?.[0];
  return JSON.stringify({
    requirements: [
      { key:'N1', requirementText:'The platform should approve every loan after a manager reviews it.', requirementType:'BUSINESS_RULE', priority:null, sourceEvidence:'The platform should approve every loan after a manager reviews it,', confidence:0.94, assumptions:[] },
      { key:'N2', requirementText:'No loan may be approved until two managers have approved it.', requirementType:'BUSINESS_RULE', priority:null, sourceEvidence:'no loan may be approved until two managers have approved it.', confidence:0.92, assumptions:[] },
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

function outputWithTemporaryKeys(request, temporaryKeys) {
  const output=JSON.parse(outputFor(request));
  const canonicalLabels=new Map(output.requirements.map((requirement,index)=>[requirement.key,temporaryKeys[index]]));
  output.requirements.forEach((requirement,index)=>{requirement.key=temporaryKeys[index];});
  for(const finding of output.findings) finding.requirementIds=finding.requirementIds.map((key)=>canonicalLabels.get(key)||key);
  for(const group of [output.securityPrivacy,output.risks,output.complianceMappings]) for(const item of group) item.requirementKeys=item.requirementKeys.map((key)=>canonicalLabels.get(key)||key);
  return JSON.stringify(output);
}

function requirementOnlyOutputFor(request) { return JSON.stringify({requirements:JSON.parse(outputFor(request)).requirements}); }
function analysisOnlyOutputFor(request) { const output=JSON.parse(outputFor(request)); const requirementTextByKey=new Map(output.requirements.map((requirement)=>[requirement.key,requirement.requirementText])); output.findings=output.findings.map(({requirementIds,...finding})=>({...finding,requirementReferences:requirementIds.map((key)=>({key,requirementText:requirementTextByKey.get(key)}))})); const {requirements,...analysis}=output; return JSON.stringify(analysis); }
function requirementOnlyOutputWithTemporaryKeys(request,temporaryKeys) { const output=JSON.parse(outputFor(request)); output.requirements.forEach((requirement,index)=>{requirement.key=temporaryKeys[index];}); return JSON.stringify({requirements:output.requirements}); }

function runWithCitationMapping(mapping) {
  const database={
    query:(sql,params)=>sql.includes('FROM knowledge_chunks c')?Promise.resolve({rows:[{chunk_id:citationChunkId,document_id:'00000000-0000-4000-8000-000000000098',title:'Citation fixture',source:'Test source',authority:null,tags:[],chunk_text:citationChunkText,similarity:0.9}]}):pool.query(sql,params),
    connect:()=>pool.connect(),
  };
  const generateOutput=async(request)=>{
    if(request.responseSchema.required.includes('requirements'))return requirementOnlyOutputFor(request);
    const analysis=JSON.parse(analysisOnlyOutputFor(request));
    analysis.complianceMappings=[mapping];
    return JSON.stringify(analysis);
  };
  return createRequirementAnalysisService({database,embedQuery:async()=>Array(768).fill(0.01),generateOutput})(projectId,inputId);
}

before(async () => {
  const app=createApp({embedQuery:async()=>Array(768).fill(0.01),generateOutput:async(request,options={})=>{
    calls+=1;
    lastRequests.push(request);
    assert.equal(options.provider,config.generation.provider); assert.deepEqual(options.fallbacks,[]); assert.equal(options.retryAttempts,1);
    if(failProvider) throw new LlmGenerationError('LLM provider is temporarily unavailable.','LLM_PROVIDER_UNAVAILABLE',503);
    options.onProviderUsed?.({provider:'test-provider',model:'test-model'});
    if(malformed)return '{bad json';
    const stage=request.responseSchema.required.includes('requirements')?'requirements':'analysis';
    if(nextRawOutput&&nextRawStage===stage)return nextRawOutput;
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
  assert.deepEqual(analysisRequest.responseSchema.required,['findings','securityPrivacy','risks','complianceMappings']);
  const findingSchema=analysisRequest.responseSchema.properties.findings.items;
  assert.ok(findingSchema.properties.requirementReferences); assert.equal(findingSchema.properties.requirementIds,undefined); assert.equal(Object.hasOwn(findingSchema.properties,'evidence'),false);
  assert.deepEqual(findingSchema.required.includes('evidence'),false);
  const mappingSchema=analysisRequest.responseSchema.properties.complianceMappings.items.properties;
  assert.equal(mappingSchema.knowledgeChunkId.type,'string'); assert.equal(mappingSchema.knowledgeChunkId.minLength,1);
  assert.equal(Object.hasOwn(mappingSchema,'evidenceQuote'),false);
  assert.equal(analysisRequest.responseSchema.properties.complianceMappings.items.required.includes('evidenceQuote'),false);
  assert.equal(analysisRequest.ollamaFormat,undefined);
  assert.ok(extractionRequest.systemPrompt.includes("Set priority to HIGH, MEDIUM, or LOW only when that exact word is present in its sourceEvidence; otherwise use null or UNKNOWN."));
  for(const scaleText of ['decimal JSON number from 0.0 to 1.0','NEVER a percentage','100% = 1.0','90% = 0.9','75% = 0.75','0.0, 0.5, 0.85, 0.95, 1.0','50, 75, 90, 100']) assert.ok(extractionRequest.systemPrompt.includes(scaleText));
  assert.match(extractionRequest.responseSchema.properties.requirements.items.properties.confidence.description,/decimal number from 0\.0 to 1\.0, never a percentage/i);
  for(const instruction of ['Actively identify source-supported requirements-engineering issues','Analyze each requirement independently before creating findings.','Every finding must reference only the requirement whose text directly supports that finding','For a finding about one requirement, include exactly that one reference.','Use multiple requirement references ONLY when the finding genuinely concerns a relationship, inconsistency, or conflict between those requirements.','copy both the key and requirementText together from the same supplied requirements or existingRequirements entry','key/text pair must match exactly','Actively check ambiguity, incompleteness, vague or unmeasurable wording, lack of testability, inconsistency/conflict, missing security controls, missing privacy controls, missing constraints, undefined terminology, and clarification needs.','Return findings: [] ONLY when the supplied requirements and source contain no source-supported issue that can reasonably be identified.','"fast" or "quickly" without a measurable threshold is a quality/testability finding','"appropriate period" without a duration is an incompleteness/clarification finding','"authenticate securely" without specified controls is a security/clarification finding','"easy to use" is a quality/testability finding','Do not provide finding evidence quotes because the backend attaches authoritative sourceEvidence','backend also attaches authoritative evidence to security/privacy observations and risks','source evidence attached to findings, security/privacy observations, and risks comes from the corresponding requirement\'s validated sourceEvidence','compliance knowledge evidence must come from the supplied retrievedKnowledge text','select only the knowledgeChunkId of a supplied retrievedKnowledge entry','Do not provide evidenceQuote; the backend attaches the corresponding retrievedKnowledge text','return no compliance mapping instead of guessing']) assert.ok(analysisRequest.systemPrompt.includes(instruction),instruction);
  const analysisContext=JSON.parse(analysisRequest.userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
  assert.deepEqual(analysisContext.requirements.map((requirement)=>requirement.key),['N1','N2','N3','N4','N5']);
  assert.ok(analysisContext.input.text.includes('two managers have approved it'));
  assert.ok(data.requirements.every((r)=>r.id&&r.sourceInputId===inputId&&r.confidence>=0&&r.confidence<=1&&source.slice(r.sourceEvidenceStart,r.sourceEvidenceEnd)===r.sourceEvidence));
  const conflict=data.findings.find((f)=>f.findingType==='CONFLICT'); assert.equal(conflict.requirementIds.length,2); assert.ok(conflict.requirementIds.every((id)=>data.requirements.some((r)=>r.id===id)));
  const singleRequirementFinding=data.findings.find((finding)=>finding.findingType==='AMBIGUITY'); assert.equal(singleRequirementFinding.requirementIds.length,1); assert.equal(singleRequirementFinding.requirementIds[0],data.requirements[2].id);
  assert.deepEqual(conflict.evidence,conflict.requirementIds.map((requirementId)=>({requirementId,quote:data.requirements.find((requirement)=>requirement.id===requirementId).sourceEvidence})));
  assert.equal(data.analysis.summary.clarificationQuestions.length,3);
  for(const type of ['AMBIGUITY','INCOMPLETENESS','QUALITY','CONSISTENCY','CONFLICT','CLASSIFICATION']) assert.ok(data.analysis.summary.findingsByType[type]>=1);
  const intelligence=data.analysis.summary.intelligence; assert.equal(intelligence.securityPrivacy.length,1); assert.equal(intelligence.risks.length,1);
  assert.equal(intelligence.securityPrivacy[0].evidenceQuote,data.requirements.find((requirement)=>requirement.id===intelligence.securityPrivacy[0].requirementIds[0]).sourceEvidence);
  assert.equal(intelligence.risks[0].evidenceQuote,data.requirements.find((requirement)=>requirement.id===intelligence.risks[0].requirementIds[0]).sourceEvidence);
  if(intelligence.knowledgeEvidence.length){ assert.equal(intelligence.complianceMappings.length,1); assert.ok(intelligence.complianceMappings[0].citation); }
  else assert.equal(intelligence.complianceMappings.length,0);
  assert.equal((await pool.query('SELECT submitted_content FROM project_inputs WHERE id=$1',[inputId])).rows[0].submitted_content,beforeInput);
  const persisted=await pool.query('SELECT provider,model_name,requirement_count,finding_count,summary FROM requirement_analysis_runs WHERE id=$1',[data.analysis.id]);
  assert.equal(persisted.rows.length,1); assert.equal(persisted.rows[0].requirement_count,5); assert.equal(persisted.rows[0].finding_count,6); assert.ok(persisted.rows[0].summary.intelligence.risks.length);
  const persistedFinding=await pool.query('SELECT evidence FROM requirement_analysis_findings WHERE id=$1',[conflict.id]);
  assert.deepEqual(persistedFinding.rows[0].evidence,conflict.evidence);
});

test('repeat operation replaces selected-input candidates without duplicates',async()=>{
  const before=(await pool.query('SELECT count(*)::int AS n FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2',[projectId,inputId])).rows[0].n;
  assert.equal(before,5); const response=await run(); assert.equal(response.status,200); const afterCount=(await pool.query('SELECT count(*)::int AS n FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2',[projectId,inputId])).rows[0].n; assert.equal(afterCount,5);
});

test('canonicalizes temporary requirement keys and remaps finding references',async()=>{
  const temporaryKeys=['req-alpha','new-approval-rule','candidate-auth','retention-req','performance-req'];
  const extracted=JSON.parse(outputWithTemporaryKeys({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`},temporaryKeys));
  nextRawOutput=JSON.stringify({requirements:extracted.requirements}); nextRawStage='requirements'; lastRequests=[];
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    assert.equal(lastRequests.length,2);
    const analysisContext=JSON.parse(lastRequests[1].userPrompt.match(/<context>([\s\S]*)<\/context>/)[1]);
    assert.deepEqual(analysisContext.requirements.map((requirement)=>requirement.key),['N1','N2','N3','N4','N5']);
    const conflict=data.findings.find((finding)=>finding.findingType==='CONFLICT');
    assert.equal(conflict.requirementIds[0],data.requirements[0].id);
    assert.equal(conflict.requirementIds[1],data.requirements[1].id);
    const auth=data.findings.find((finding)=>finding.findingType==='AMBIGUITY');
    assert.equal(auth.requirementIds[0],data.requirements[2].id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2',[projectId,inputId])).rows[0].n,5);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('preserves finding references to existing requirement UUIDs during key remapping',async()=>{
  const existingEvidence='The customer portal shall show the account status.';
  const secondaryInputResponse=await fetch(`${baseUrl}/projects/${projectId}/inputs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Existing requirement source',source:'Integration fixture',inputType:'STAKEHOLDER_STATEMENT',content:existingEvidence})});
  assert.equal(secondaryInputResponse.status,201);
  const secondaryInputId=(await secondaryInputResponse.json()).data.id;
  const existingId=(await pool.query(`INSERT INTO candidate_requirements (project_id,source_input_id,requirement_text,requirement_type,source_evidence,source_evidence_start,source_evidence_end,confidence,assumptions) VALUES ($1,$2,$3,'FUNCTIONAL',$3,0,$4,0.9,'{}') RETURNING id`,[projectId,secondaryInputId,existingEvidence,existingEvidence.length])).rows[0].id;
  const generated=JSON.parse(outputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  const quality=generated.findings.find((finding)=>finding.findingType==='QUALITY');
  quality.requirementIds=[existingId,'N5'];
  quality.evidence=[{requirementId:'N5',quote:'MODEL-FABRICATED-EVIDENCE-MUST-BE-IGNORED'}];
  const requirementTextByKey=new Map(generated.requirements.map((requirement)=>[requirement.key,requirement.requirementText])); requirementTextByKey.set(existingId,existingEvidence);
  generated.findings=generated.findings.map(({requirementIds,...finding})=>({...finding,requirementReferences:requirementIds.map((key)=>({key,requirementText:requirementTextByKey.get(key)}))}));
  const {requirements,...analysis}=generated;
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis';
  try {
    const response=await run(); assert.equal(response.status,200,await response.clone().text());
    const data=(await response.json()).data;
    const savedFinding=data.findings.find((finding)=>finding.findingType==='QUALITY');
    assert.deepEqual(savedFinding.requirementIds,[existingId,data.requirements[4].id]);
    assert.deepEqual(savedFinding.evidence,[{requirementId:existingId,quote:existingEvidence},{requirementId:data.requirements[4].id,quote:'The system should be fast.'}]);
    assert.equal(JSON.stringify(savedFinding.evidence).includes('MODEL-FABRICATED-EVIDENCE-MUST-BE-IGNORED'),false);
    assert.ok(data.requirements.some((requirement)=>requirement.id===existingId)===false);
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('accepts and persists compliance mappings with backend-attached retrieved chunk evidence',async()=>{
  const mapping={title:'Fraud review control',observation:'Fraud review is a relevant payment control topic.',requirementKeys:['N4'],knowledgeChunkId:citationChunkId,confidence:0.8};
  const data=await runWithCitationMapping(mapping);
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

test('rejects compliance mappings with an unknown knowledgeChunkId',async()=>{
  const mapping={title:'Fraud review control',observation:'Fraud review is a relevant payment control topic.',requirementKeys:['N4'],knowledgeChunkId:'00000000-0000-4000-8000-000000000097',confidence:0.8};
  await assert.rejects(runWithCitationMapping(mapping),(error)=>error.diagnosticReason==='KNOWLEDGE_CITATION_EVIDENCE');
});

test('Call 2 rejects finding references that do not identify canonical or existing requirements',async()=>{
  const rejected=JSON.parse(outputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  const requirementTextByKey=new Map(rejected.requirements.map((requirement)=>[requirement.key,requirement.requirementText]));
  rejected.findings=rejected.findings.map(({requirementIds,...finding})=>({...finding,requirementReferences:requirementIds.map((key)=>({key,requirementText:requirementTextByKey.get(key)}))}));
  const {requirements,...analysis}=rejected;
  analysis.findings[0].requirementReferences[0].key='temporary-llm-key';
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis'; calls=0;
  try {
    const response=await run();
    assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');
  } finally { nextRawOutput=null; nextRawStage='analysis'; }
  assert.equal(calls,2,'Call 2 reference validation follows successful canonicalization in Call 1');
});

test('Call 2 rejects a known requirement key paired with another requirement text',async()=>{
  const rejected=JSON.parse(outputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  const requirementTextByKey=new Map(rejected.requirements.map((requirement)=>[requirement.key,requirement.requirementText]));
  rejected.findings=rejected.findings.map(({requirementIds,...finding})=>({...finding,requirementReferences:requirementIds.map((key)=>({key,requirementText:requirementTextByKey.get(key)}))}));
  const {requirements,...analysis}=rejected;
  const retention=analysis.findings.find((finding)=>finding.title==='Retention period is missing');
  retention.requirementReferences[0].requirementText='Users should authenticate securely.';
  nextRawOutput=JSON.stringify(analysis); nextRawStage='analysis';
  try { const response=await run(); assert.equal(response.status,502); assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT'); }
  finally { nextRawOutput=null; nextRawStage='analysis'; }
});

test('canonical key collision with a known requirement is still rejected',async()=>{
  const inputIdForService='test-input';
  const fakeDatabase={query:async(sql)=>{
    if(sql.includes('FROM projects'))return {rows:[{id:'test-project',selected_domain:'Test'}]};
    if(sql.includes('FROM project_inputs'))return {rows:[{id:inputIdForService,project_id:'test-project',input_type:'INTERVIEW_TRANSCRIPT',title:'Test',processing_status:'READY',submitted_content:source}]};
    if(sql.includes('FROM candidate_requirements'))return {rows:[{id:'N1',source_input_id:'other-input',requirement_text:'Known requirement.',requirement_type:'FUNCTIONAL',source_evidence:'Known requirement.'}]};
    return {rows:[]};
  }};
  const runFake=createRequirementAnalysisService({database:fakeDatabase,embedQuery:async()=>[],generateOutput:async(request)=>requirementOnlyOutputWithTemporaryKeys(request,['req-alpha','new-approval-rule','candidate-auth','retention-req','performance-req'])});
  await assert.rejects(runFake('test-project',inputIdForService),(error)=>error.diagnosticReason==='REQUIREMENT_KEY_SEQUENCE');
});

test('provider failure and malformed output do not create fake findings or replace saved candidates',async()=>{
  const ids=(await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 ORDER BY id',[projectId])).rows.map((r)=>r.id);
  failProvider=true; try {const response=await run();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'LLM_PROVIDER_UNAVAILABLE');} finally {failProvider=false;}
  malformed=true; try {const response=await run();assert.equal(response.status,502);assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');} finally {malformed=false;}
  assert.deepEqual((await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 ORDER BY id',[projectId])).rows.map((r)=>r.id),ids);
});

test('invalid requirement fields log a safe field-specific diagnostic without source text',async()=>{
  const rejected=JSON.parse(outputFor({userPrompt:`<context>${JSON.stringify({retrievedKnowledge:[]})}</context>`}));
  rejected.requirements[0].confidence='not-a-number';
  rejected.requirements[0].sourceEvidence='SENSITIVE-SOURCE-EVIDENCE-MUST-NOT-BE-LOGGED';
  const before=(await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id);
  nextRawOutput=JSON.stringify({requirements:rejected.requirements}); nextRawStage='requirements'; calls=0; lastRequests=[];
  const originalWarn=console.warn; let diagnostic;
  console.warn=(message,details)=>{if(message==='Requirements Intelligence output rejected.')diagnostic=details;};
  try {
    const response=await run();
    assert.equal(response.status,502);
    assert.equal((await response.json()).error.code,'INVALID_ANALYSIS_OUTPUT');
  } finally { nextRawOutput=null; nextRawStage='analysis'; console.warn=originalWarn; }
  assert.equal(calls,1,'Call 1 validation failure must prevent Call 2');
  assert.deepEqual((await pool.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,inputId])).rows.map((row)=>row.id),before);
  assert.equal(diagnostic.diagnosticReason,'REQUIREMENT_REQUIREMENT_FIELD_OR_CONFIDENCE');
  assert.deepEqual(diagnostic.diagnosticDetail,{field:'confidence',validationReason:'must be a JSON number from 0 to 1',safeValue:{type:'string',length:12}});
  assert.equal(JSON.stringify(diagnostic).includes('SENSITIVE-SOURCE-EVIDENCE-MUST-NOT-BE-LOGGED'),false);
});
