import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { generateStructuredOutput, LlmGenerationError } from './llm-generation.js';
import { embedSearchQuery, EmbeddingProviderError } from './embeddings.js';
import { RequirementAnalysisError } from './analysis-validation.js';
import { validateRequirementOutput } from './requirement-extraction.js';

const MAX_INPUT_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_REQUIREMENTS = 5;
const MAX_FINDINGS = 6;
const MAX_OBSERVATIONS = 1;
const MAX_SECURITY_PRIVACY = 2;
const TYPES = ['AMBIGUITY', 'INCOMPLETENESS', 'QUALITY', 'CONSISTENCY', 'CONFLICT', 'CLASSIFICATION', 'CLARIFICATION'];
const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH'];
const requirementItemsSchema = { type: 'array', maxItems: MAX_REQUIREMENTS, items: {
  type: 'object', additionalProperties: false, properties: {
    key: { type: 'string', minLength: 1, maxLength: 12 }, requirementText: { type: 'string', minLength: 1, maxLength: 400 },
    requirementType: { type: 'string', enum: ['FUNCTIONAL', 'NON_FUNCTIONAL', 'BUSINESS_RULE', 'CONSTRAINT', 'OTHER', 'UNKNOWN'] },
    priority: { anyOf: [{ type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] }, { type: 'null' }] },
    sourceEvidence: { type: 'string', minLength: 1, maxLength: 150 }, confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence is a decimal number from 0.0 to 1.0, never a percentage. 100% = 1.0, 90% = 0.9, 75% = 0.75. Valid examples: 0.0, 0.5, 0.85, 0.95, 1.0. Invalid examples: 50, 75, 90, 100.' },
    assumptions: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 100 } },
  }, required: ['key', 'requirementText', 'requirementType', 'priority', 'sourceEvidence', 'confidence', 'assumptions'],
} };
const findingsSchema = { type: 'array', maxItems: MAX_FINDINGS, items: {
      type: 'object', additionalProperties: false, properties: {
        findingType: { type: 'string', enum: TYPES }, severity: { type: 'string', enum: SEVERITIES },
        title: { type: 'string', minLength: 1, maxLength: 50 }, description: { type: 'string', minLength: 1, maxLength: 100 },
        requirementReferences: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', additionalProperties: false, properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 }, requirementText: { type: 'string', minLength: 1, maxLength: 3000 },
        }, required: ['key', 'requirementText'] } },
        clarificationQuestion: { type: ['string', 'null'], maxLength: 100 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      }, required: ['findingType', 'severity', 'title', 'description', 'requirementReferences', 'clarificationQuestion', 'confidence'],
    } };
const securityPrivacySchema = { type: 'array', maxItems: MAX_SECURITY_PRIVACY, items: { type: 'object', additionalProperties: false, properties: {
      category: { type: 'string', enum: ['SECURITY', 'PRIVACY'] }, title: { type: 'string', maxLength: 50 }, observation: { type: 'string', maxLength: 120 },
      requirementKeys: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 64 } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    }, required: ['category', 'title', 'observation', 'requirementKeys', 'confidence'] } };
const risksSchema = { type: 'array', maxItems: MAX_OBSERVATIONS, items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', maxLength: 50 }, observation: { type: 'string', maxLength: 120 }, requirementKeys: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 64 } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    }, required: ['title', 'observation', 'requirementKeys', 'confidence'] } };
const complianceMappingsSchema = { type: 'array', maxItems: MAX_OBSERVATIONS, items: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', maxLength: 50 }, observation: { type: 'string', maxLength: 120 }, requirementKeys: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 64 } },
      knowledgeChunkId: { type: 'string', minLength: 1, maxLength: 64 }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    }, required: ['title', 'observation', 'requirementKeys', 'knowledgeChunkId', 'confidence'] } };
const requirementsSchema = {
  type: 'object', additionalProperties: false,
  properties: { requirements: requirementItemsSchema }, required: ['requirements'],
};
const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: { findings: findingsSchema, securityPrivacy: securityPrivacySchema, risks: risksSchema, complianceMappings: complianceMappingsSchema },
  required: ['findings', 'securityPrivacy', 'risks', 'complianceMappings'],
};

const extractionSystemPrompt = `Requirements Extraction phase of the single Requirements Intelligence agent. Extract up to ${MAX_REQUIREMENTS} concise, independently testable requirement clauses from input.text. Split genuinely distinct clauses that could conflict into separate requirements; do not split merely to create issues. Copy each sourceEvidence as a non-empty contiguous quote from input.text. Confidence MUST be a decimal JSON number from 0.0 to 1.0, NEVER a percentage: 100% = 1.0, 90% = 0.9, and 75% = 0.75. Valid examples: 0.0, 0.5, 0.85, 0.95, 1.0. Invalid examples: 50, 75, 90, 100. Set priority to HIGH, MEDIUM, or LOW only when that exact word is present in its sourceEvidence; otherwise use null or UNKNOWN. Do not infer priority. Use a unique temporary key for each item; the backend will assign canonical keys. Return only JSON matching the supplied requirements schema.`;
const analysisSystemPrompt = `Requirements Analysis phase of the single Requirements Intelligence agent. Actively identify source-supported requirements-engineering issues; do not merely summarize or classify requirements. Analyze each requirement independently before creating findings. Every finding must reference only the requirement whose text directly supports that finding; do not include a requirement merely because it is related to the same topic or context. For a finding about one requirement, include exactly that one reference. Use multiple requirement references ONLY when the finding genuinely concerns a relationship, inconsistency, or conflict between those requirements. In each finding's requirementReferences, copy both the key and requirementText together from the same supplied requirements or existingRequirements entry; the key/text pair must match exactly. Do not infer, renumber, or mix keys and text from different entries. The backend validates every key/text pair against the authoritative requirement. Actively check ambiguity, incompleteness, vague or unmeasurable wording, lack of testability, inconsistency/conflict, missing security controls, missing privacy controls, missing constraints, undefined terminology, and clarification needs. For example, "fast" or "quickly" without a measurable threshold is a quality/testability finding; "appropriate period" without a duration is an incompleteness/clarification finding; "authenticate securely" without specified controls is a security/clarification finding; vague usability wording such as "easy to use" is a quality/testability finding. Return findings: [] ONLY when the supplied requirements and source contain no source-supported issue that can reasonably be identified. Report only issues supported by the supplied source; do not invent findings. Do not provide finding evidence quotes because the backend attaches authoritative sourceEvidence for each verified requirement reference. The backend also attaches authoritative evidence to security/privacy observations and risks from their referenced requirements. Keep evidence sources distinct: source evidence attached to findings, security/privacy observations, and risks comes from the corresponding requirement's validated sourceEvidence; compliance knowledge evidence must come from the supplied retrievedKnowledge text. For each compliance mapping, select only the knowledgeChunkId of a supplied retrievedKnowledge entry that supports it. Do not provide evidenceQuote; the backend attaches the corresponding retrievedKnowledge text. If no supplied knowledge entry supports a compliance mapping, return no compliance mapping instead of guessing. Map policy topics only to supplied knowledge evidence; do not make legal conclusions. Return only JSON matching the supplied analysis schema.`;

export function createRequirementAnalysisService({ database = pool, generateOutput = generateStructuredOutput, embedQuery = embedSearchQuery } = {}) {
  return async function runIntelligence(projectId, inputId) {
    let project, input, existing;
    try {
      const p = await database.query('SELECT id,name,selected_domain FROM projects WHERE id=$1', [projectId]);
      project = p.rows[0];
      if (!project) throw new RequirementAnalysisError('Project not found.', 'PROJECT_NOT_FOUND', 404);
      const i = await database.query(`SELECT id,project_id,input_type,title,source,original_filename,processing_status,submitted_content,extracted_text FROM project_inputs WHERE id=$1 AND project_id=$2`, [inputId, projectId]);
      input = i.rows[0];
      if (!input) throw new RequirementAnalysisError('Input was not found in this project.', 'INPUT_NOT_FOUND', 404);
      if (input.processing_status !== 'READY') throw new RequirementAnalysisError('Only READY project inputs can be analyzed.', 'INPUT_NOT_READY', 409);
      const r = await database.query(`SELECT r.id,r.source_input_id,r.requirement_text,r.requirement_type,r.priority,r.source_evidence,r.assumptions FROM candidate_requirements r WHERE r.project_id=$1 ORDER BY r.id`, [projectId]);
      existing = r.rows;
    } catch (error) { if (error instanceof RequirementAnalysisError) throw error; throw databaseFailure(); }
    const sourceText = input.input_type === 'DOCUMENT' ? input.extracted_text : input.submitted_content;
    if (!sourceText?.trim()) throw new RequirementAnalysisError('The READY input has no text available for analysis.', 'SOURCE_INPUT_EMPTY', 422);
    if (sourceText.length > MAX_INPUT_CHARS) throw new RequirementAnalysisError(`Input is ${sourceText.length} characters; the safe limit is ${MAX_INPUT_CHARS}. Split it into smaller inputs.`, 'INTELLIGENCE_INPUT_TOO_LARGE', 413);
    // The selected input will be replaced atomically; do not let its stale
    // candidates appear as existing IDs in the model context.
    existing = existing.filter((r) => r.source_input_id !== input.id);
    if (existing.length > MAX_REQUIREMENTS) throw new RequirementAnalysisError(`This project has ${existing.length} existing requirements; the safe context limit is ${MAX_REQUIREMENTS}.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const requirementsContext = existing.map((r) => ({ key: r.id, requirementText: r.requirement_text, requirementType: r.requirement_type, sourceEvidence: r.source_evidence }));
    let provider = { provider: 'unknown', model: 'unknown' };
    const generationOptions = { provider: config.generation.provider, fallbacks: [], retryAttempts: 1, timeoutMillis: config.generation.timeoutMillis, onProviderUsed: (value) => { provider = value; } };
    const generateStage = async (request) => {
      try { return await generateOutput(request, generationOptions); }
      catch (error) { if (error instanceof LlmGenerationError) throw error; throw new LlmGenerationError('The configured LLM provider could not complete Requirements Intelligence.', 'LLM_PROVIDER_UNAVAILABLE', 503); }
    };

    const extractionContext = { project: { domain: project.selected_domain }, input: { id: input.id, title: input.title, text: sourceText }, existingRequirements: requirementsContext };
    const extractionUserPrompt = `Extract at most ${MAX_REQUIREMENTS} requirements. Keep each field concise and quote source evidence exactly. Return requirements only.\n<context>${JSON.stringify(extractionContext)}\n</context>`;
    if (extractionUserPrompt.length > MAX_CONTEXT_CHARS) throw new RequirementAnalysisError(`Prepared context is ${extractionUserPrompt.length} characters; safe limit is ${MAX_CONTEXT_CHARS}. Reduce the input or candidate set.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const rawRequirements = await generateStage({ systemPrompt: extractionSystemPrompt, userPrompt: extractionUserPrompt, responseSchema: requirementsSchema, modelPurpose: 'requirements-intelligence', maxTokens: 1100 });
    let extracted;
    try { extracted = validateRequirementsOutput(rawRequirements, sourceText, requirementsContext); }
    catch (error) { logValidationRejection(error, 'requirement-extraction'); throw error; }

    const queryText = `${project.selected_domain || ''} ${input.title} ${sourceText.slice(0, 1400)} security privacy risk policy compliance`;
    let kbEvidence = [];
    try {
      const vector = await embedQuery(queryText);
      const found = await database.query(`SELECT c.id AS chunk_id,d.id AS document_id,d.title,d.source,d.authority,d.tags,c.chunk_text,1-(c.embedding <=> $1::vector) AS similarity FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.knowledge_document_id WHERE d.processing_status='READY' ORDER BY c.embedding <=> $1::vector LIMIT 1`, [`[${vector.join(',')}]`]);
      kbEvidence = found.rows.map((row) => ({ chunkId: row.chunk_id, documentId: row.document_id, title: row.title, source: row.source, authority: row.authority, tags: row.tags, text: row.chunk_text, similarity: Number(row.similarity) }));
    } catch (error) { if (!(error instanceof EmbeddingProviderError)) throw databaseFailure(); /* no retrieval evidence is an explicit state */ }
    kbEvidence = kbEvidence.map((entry) => ({ ...entry, text: entry.text.slice(0, 250) }));
    const analysisContext = { project: { domain: project.selected_domain }, input: { id: input.id, title: input.title, text: sourceText }, existingRequirements: requirementsContext, requirements: extracted.requirements, retrievedKnowledge: kbEvidence };
    const analysisUserPrompt = `Analyze these source-grounded requirements. Limits: findings ${MAX_FINDINGS}; securityPrivacy ${MAX_SECURITY_PRIVACY}; risks ${MAX_OBSERVATIONS}; complianceMappings ${MAX_OBSERVATIONS}. Return analysis arrays only.\n<context>${JSON.stringify(analysisContext)}\n</context>`;
    if (analysisUserPrompt.length > MAX_CONTEXT_CHARS) throw new RequirementAnalysisError(`Prepared context is ${analysisUserPrompt.length} characters; safe limit is ${MAX_CONTEXT_CHARS}. Reduce the input or candidate set.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const rawAnalysis = await generateStage({ systemPrompt: analysisSystemPrompt, userPrompt: analysisUserPrompt, responseSchema: analysisSchema, modelPurpose: 'requirements-intelligence', maxTokens: 1100 });
    let analysis;
    try { analysis = validateAnalysisOutput(rawAnalysis, sourceText, extracted.requirements, requirementsContext, kbEvidence); }
    catch (error) { logValidationRejection(error, 'requirement-analysis'); throw error; }
    const output = { ...analysis, requirements: extracted.requirements, normalizedRequirements: extracted.normalizedRequirements };
    return persist(database, projectId, input, existing, output, provider, kbEvidence);
  };
}

function validateRequirementsOutput(raw, sourceText, known) {
  let out; try { out = JSON.parse(raw); } catch (error) { throw invalidOutput(`INVALID_JSON:${raw.length}:${raw.trimEnd().endsWith('}')}:${String(error.message).match(/position\s+(\d+)/i)?.[1] || 'unknown'}`); }
  if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== 1 || !Object.hasOwn(out,'requirements') || !Array.isArray(out.requirements)) throw invalidOutput('REQUIREMENTS_ROOT_OR_ARRAY_SHAPE');
  if (out.requirements.length > MAX_REQUIREMENTS || out.requirements.some((r) => !r || typeof r !== 'object' || Array.isArray(r) || typeof r.key !== 'string')) throw invalidOutput('ARRAY_LIMIT_OR_REQUIREMENT_SHAPE');
  assignCanonicalRequirementKeys(out.requirements, known);
  let newReq;
  try { newReq = validateRequirementOutput(JSON.stringify({ requirements: out.requirements.map(({ key, ...r }) => r) }), sourceText); } catch (error) { const wrapped=invalidOutput(`REQUIREMENT_${error.diagnosticReason || 'VALIDATION'}`); wrapped.diagnosticDetail=error.diagnosticDetail; throw wrapped; }
  const idMap = new Map(known.map((r) => [r.key,r.key]));
  out.requirements.forEach((r,i) => { if (r.key !== `N${i+1}` || idMap.has(r.key)) throw invalidOutput('REQUIREMENT_KEY_SEQUENCE'); idMap.set(r.key, null); });
  return { requirements: out.requirements, normalizedRequirements: newReq };
}

function validateAnalysisOutput(raw, sourceText, requirements, known, kb) {
  let out; try { out = JSON.parse(raw); } catch (error) { throw invalidOutput(`INVALID_JSON:${raw.length}:${raw.trimEnd().endsWith('}')}:${String(error.message).match(/position\s+(\d+)/i)?.[1] || 'unknown'}`); }
  const keys = ['findings','securityPrivacy','risks','complianceMappings'];
  if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== keys.length || keys.some((k) => !Object.hasOwn(out,k)) || keys.some((key) => !Array.isArray(out[key]))) throw invalidOutput('ANALYSIS_ROOT_OR_ARRAY_SHAPE');
  if (out.findings.length > MAX_FINDINGS) throw invalidOutput('ARRAY_LIMIT_OR_FINDING_SHAPE');
  const idMap = new Map(known.map((r) => [r.key,r.key]));
  requirements.forEach((r,i) => { if (r.key !== `N${i+1}` || idMap.has(r.key)) throw invalidOutput('REQUIREMENT_KEY_SEQUENCE'); idMap.set(r.key, null); });
  const authoritativeEvidence = new Map([...known.map((r) => [r.key,r.sourceEvidence]), ...requirements.map((r) => [r.key,r.sourceEvidence])]);
  const authoritativeRequirementText = new Map([...known.map((r) => [r.key,r.requirementText]), ...requirements.map((r) => [r.key,r.requirementText])]);
  out.findings.forEach((f, findingIndex) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw findingValidationFailure(findingIndex,'finding','must be an object',f);
    if (!TYPES.includes(f.findingType)) throw findingValidationFailure(findingIndex,'findingType','must be one of the supported finding types',f.findingType);
    if (!SEVERITIES.includes(f.severity)) throw findingValidationFailure(findingIndex,'severity','must be one of the supported severity values',f.severity);
    if (!shortText(f.title,120)) throw findingValidationFailure(findingIndex,'title','must be non-empty and at most 120 characters',f.title);
    if (!shortText(f.description,500)) throw findingValidationFailure(findingIndex,'description','must be non-empty and at most 500 characters',f.description);
    if (!(f.clarificationQuestion === null || shortText(f.clarificationQuestion,240))) throw findingValidationFailure(findingIndex,'clarificationQuestion','must be null or non-empty and at most 240 characters',f.clarificationQuestion);
    if (!validConfidence(f.confidence)) throw findingValidationFailure(findingIndex,'confidence','must be a JSON number from 0 to 1',f.confidence);
    if (!Array.isArray(f.requirementReferences) || !f.requirementReferences.length) throw findingValidationFailure(findingIndex,'requirementReferences','must be a non-empty array of key/text pairs',f.requirementReferences);
    f.requirementIds = f.requirementReferences.map((reference,keyIndex) => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference) || typeof reference.key !== 'string' || typeof reference.requirementText !== 'string') throw findingValidationFailure(findingIndex,'requirementReferences','each reference must contain a key and requirementText',reference,keyIndex);
      if (!idMap.has(reference.key)) throw findingValidationFailure(findingIndex,'requirementReferences','key does not identify a known requirement',reference.key,keyIndex);
      if (reference.requirementText !== authoritativeRequirementText.get(reference.key)) throw findingValidationFailure(findingIndex,'requirementReferences','requirementText does not exactly match the requirement for this key',{key:reference.key,requirementTextLength:reference.requirementText.length},keyIndex);
      return reference.key;
    });
    delete f.requirementReferences;
    f.requirementIds.forEach((key,keyIndex) => {
      if (!idMap.has(key)) throw findingValidationFailure(findingIndex,'requirementIds','contains an ID that does not identify a known requirement',key,keyIndex);
      const quote=authoritativeEvidence.get(key);
      if (typeof quote !== 'string' || !quote.length) throw findingValidationFailure(findingIndex,'requirementIds','referenced requirement has no authoritative source evidence',key,keyIndex);
    });
    if (['CONFLICT','CONSISTENCY'].includes(f.findingType) && new Set(f.requirementIds).size < 2) throw invalidOutput('MULTI_REQUIREMENT_FINDING',{field:'requirementIds',validationReason:'conflict/consistency findings must reference at least two distinct requirements',findingIndex,safeValue:{count:new Set(f.requirementIds).size}});
    f.evidence=f.requirementIds.map((requirementId)=>({requirementId,quote:authoritativeEvidence.get(requirementId)}));
  });
  const checkObs = (items, compliance = false, limit = MAX_OBSERVATIONS) => {
    if (!Array.isArray(items) || items.length > limit) throw invalidOutput('OBSERVATION_LIMIT');
    for (const [mappingIndex,item] of items.entries()) {
      if (!item || typeof item !== 'object' || !shortText(item.title,120) || !shortText(item.observation,400) || !validConfidence(item.confidence) || !Array.isArray(item.requirementKeys) || !item.requirementKeys.length || item.requirementKeys.some((k) => !idMap.has(k)) || !compliance && item.requirementKeys.length !== 1) throw invalidOutput('OBSERVATION_SHAPE_OR_REQUIREMENT_KEY');
      if (!compliance) {
        const evidence=authoritativeEvidence.get(item.requirementKeys[0]);
        if(typeof evidence!=='string'||!evidence.length)throw invalidOutput('OBSERVATION_SOURCE_EVIDENCE');
        item.evidenceQuote=evidence;
      }
      if (!compliance && items === out.securityPrivacy && !['SECURITY','PRIVACY'].includes(item.category)) throw invalidOutput('SECURITY_PRIVACY_CATEGORY');
      if (compliance) {
        if(typeof item.knowledgeChunkId!=='string'||!item.knowledgeChunkId)throw invalidOutput('KNOWLEDGE_CITATION_ID',{field:'complianceMappings',mappingIndex,chunkIdMatched:false});
        const matchingChunk=kb.find((entry)=>entry.chunkId===item.knowledgeChunkId);
        if(!matchingChunk)throw invalidOutput('KNOWLEDGE_CITATION_EVIDENCE',{field:'complianceMappings',mappingIndex,chunkIdMatched:false,quoteMatched:false,quoteLength:null});
        item.evidenceQuote=matchingChunk.text;
      }
    }
  };
  checkObs(out.securityPrivacy,false,MAX_SECURITY_PRIVACY); checkObs(out.risks); checkObs(out.complianceMappings,true);
  const missingCitationIndex=out.complianceMappings.findIndex((m)=>!m.knowledgeChunkId||!m.evidenceQuote);
  if (missingCitationIndex>=0) {
    const mapping=out.complianceMappings[missingCitationIndex];
    throw invalidOutput('KNOWLEDGE_CITATION_REQUIRED',{field:'complianceMappings',mappingIndex:missingCitationIndex,chunkIdPresent:Boolean(mapping.knowledgeChunkId),quotePresent:Boolean(mapping.evidenceQuote),quoteLength:typeof mapping.evidenceQuote==='string'?mapping.evidenceQuote.length:null});
  }
  return out;
}

function assignCanonicalRequirementKeys(requirements, known) {
  const existingKeys = new Set(known.map((r) => r.key));
  const canonicalByTemporaryKey = new Map();
  requirements.forEach((requirement, index) => {
    if (!requirement.key || existingKeys.has(requirement.key) || canonicalByTemporaryKey.has(requirement.key)) throw invalidOutput('REQUIREMENT_KEY_SEQUENCE');
    canonicalByTemporaryKey.set(requirement.key, `N${index + 1}`);
  });
  requirements.forEach((requirement) => { requirement.key = canonicalByTemporaryKey.get(requirement.key); });
}

function logValidationRejection(error, stage) {
  if (error instanceof RequirementAnalysisError) console.warn('Requirements Intelligence output rejected.', { stage, diagnosticReason: error.diagnosticReason || 'OUTPUT_VALIDATION', ...(error.diagnosticDetail ? { diagnosticDetail: error.diagnosticDetail } : {}) });
}

async function persist(database, projectId, input, existing, out, provider, kb) {
  const client = await database.connect(); const runId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    await client.query('DELETE FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2', [projectId,input.id]);
    const saved = new Map(existing.map((r) => [r.id,r.id]));
    const requirements = [];
    for (let i=0; i<out.normalizedRequirements.length; i++) {
      const r = out.normalizedRequirements[i];
      const row = (await client.query(`INSERT INTO candidate_requirements (project_id,source_input_id,requirement_text,requirement_type,priority,source_evidence,source_evidence_start,source_evidence_end,confidence,assumptions,extraction_status,generation_provider,generation_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'COMPLETED',$11,$12) RETURNING *`, [projectId,input.id,r.requirementText,r.requirementType,r.priority,r.sourceEvidence,r.sourceEvidenceStart,r.sourceEvidenceEnd,r.confidence,r.assumptions,provider.provider,provider.model])).rows[0];
      saved.set(out.requirements[i].key,row.id); requirements.push(row);
    }
    const allIds = [...saved.values()].sort();
    const mappedFindings = out.findings.map((f) => ({ ...f, requirementIds: f.requirementIds.map((key) => saved.get(key)), evidence:f.evidence.map((item)=>({...item,requirementId:saved.get(item.requirementId)})), id: randomUUID() }));
    const summary = { requirementsWithFindings: [...new Set(mappedFindings.flatMap((f) => f.requirementIds))], requirementsWithoutFindings: allIds.filter((id) => !mappedFindings.some((f) => f.requirementIds.includes(id))), findingsByType: countBy(mappedFindings,'findingType'), findingsBySeverity: countBy(mappedFindings,'severity'), clarificationQuestions: mappedFindings.filter((f) => f.clarificationQuestion).map((f) => ({ findingId:f.id, requirementIds:f.requirementIds, question:f.clarificationQuestion })), intelligence: { securityPrivacy: mapRefs(out.securityPrivacy,saved), risks: mapRefs(out.risks,saved), complianceMappings: out.complianceMappings.map((m)=>({...m,requirementIds:m.requirementKeys.map((k)=>saved.get(k)).filter(Boolean),citation:kb.find((entry)=>entry.chunkId===m.knowledgeChunkId)||null})), knowledgeEvidence: kb, generatedAt: new Date().toISOString() } };
    await client.query('DELETE FROM requirement_analysis_runs WHERE project_id=$1',[projectId]);
    await client.query(`INSERT INTO requirement_analysis_runs (id,project_id,requirement_ids,status,provider,model_name,provider_metadata,requirement_count,finding_count,summary) VALUES ($1,$2,$3,'COMPLETED',$4,$5,$6::jsonb,$7,$8,$9::jsonb)`, [runId,projectId,allIds,provider.provider,provider.model,JSON.stringify(provider),allIds.length,mappedFindings.length,JSON.stringify(summary)]);
    for (const f of mappedFindings) await client.query(`INSERT INTO requirement_analysis_findings (id,analysis_run_id,requirement_ids,agent_names,finding_type,severity,title,description,evidence,clarification_question,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [f.id,runId,f.requirementIds,['Requirements Intelligence Agent'],f.findingType,f.severity,f.title,f.description,JSON.stringify(f.evidence),f.clarificationQuestion,f.confidence]);
    await client.query('COMMIT');
    return { requirements: requirements.map((r) => ({ id:r.id, projectId:r.project_id, sourceInputId:r.source_input_id, requirementText:r.requirement_text, requirementType:r.requirement_type, priority:r.priority, sourceEvidence:r.source_evidence, sourceEvidenceStart:r.source_evidence_start, sourceEvidenceEnd:r.source_evidence_end, confidence:Number(r.confidence), assumptions:r.assumptions, extractionStatus:r.extraction_status, provider:r.generation_provider, modelName:r.generation_model })), sourceInput:{id:input.id,title:input.title,source:input.source,inputType:input.input_type,originalFilename:input.original_filename}, provider:provider.provider, modelName:provider.model, ...await loadCurrentProjectAnalysis(database,projectId) };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error instanceof RequirementAnalysisError ? error : databaseFailure(); }
  finally { client.release(); }
}

function mapRefs(items, saved) { return items.map((item) => ({ ...item, requirementIds:item.requirementKeys.map((k)=>saved.get(k)).filter(Boolean) })); }
function countBy(items,key) { return items.reduce((o,x)=>(o[x[key]]=(o[x[key]]||0)+1,o),{}); }
function validConfidence(value) { return Number.isFinite(value) && value>=0 && value<=1; }
function shortText(value,max) { return typeof value==='string' && value.trim().length>0 && value.length<=max; }
function findingValidationFailure(findingIndex,field,validationReason,value,itemIndex) {
  let safeValue=typeof value==='string'?{type:'string',length:value.length}:Array.isArray(value)?{type:'array',length:value.length}:value&&typeof value==='object'?{type:'object'}:value;
  if(itemIndex!==undefined&&safeValue&&typeof safeValue==='object'&&!Array.isArray(safeValue))safeValue={index:itemIndex,...safeValue};
  return invalidOutput('FINDING_SHAPE_OR_SOURCE_EVIDENCE',{field,validationReason,findingIndex,safeValue});
}
function invalidOutput(reason='OUTPUT_VALIDATION',detail) { const error=new RequirementAnalysisError('The Requirements Intelligence response did not pass structured output, source evidence, or citation validation. No previous results were changed.', 'INVALID_ANALYSIS_OUTPUT', 502); error.diagnosticReason=reason; if(detail)error.diagnosticDetail=detail; return error; }
function databaseFailure() { return new RequirementAnalysisError('The database operation for Requirements Intelligence failed.', 'DATABASE_ERROR', 503); }

export async function loadCurrentProjectAnalysis(database, projectId) {
  const project = await database.query('SELECT id FROM projects WHERE id=$1',[projectId]);
  if (!project.rowCount) throw new RequirementAnalysisError('Project not found.','PROJECT_NOT_FOUND',404);
  const [runs,candidates] = await Promise.all([database.query('SELECT * FROM requirement_analysis_runs WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[projectId]),database.query('SELECT id FROM candidate_requirements WHERE project_id=$1 ORDER BY id',[projectId])]);
  const row=runs.rows[0]; if(!row) return {analysis:null,findings:[]};
  const ids=candidates.rows.map(x=>x.id).sort(); if(ids.length!==row.requirement_ids.length||ids.some((id,i)=>id!==[...row.requirement_ids].sort()[i])) return {analysis:null,findings:[]};
  const rows=await database.query('SELECT * FROM requirement_analysis_findings WHERE analysis_run_id=$1 ORDER BY created_at,id',[row.id]);
  return {analysis:{id:row.id,projectId:row.project_id,requirementIds:row.requirement_ids,status:row.status,provider:row.provider,modelName:row.model_name,providerByAgent:row.provider_metadata,requirementCount:row.requirement_count,findingCount:row.finding_count,summary:row.summary,createdAt:row.created_at},findings:rows.rows.map((r)=>({id:r.id,analysisRunId:r.analysis_run_id,requirementIds:r.requirement_ids,agentNames:r.agent_names,findingType:r.finding_type,severity:r.severity,title:r.title,description:r.description,evidence:r.evidence,clarificationQuestion:r.clarification_question,confidence:Number(r.confidence),createdAt:r.created_at}))};
}
