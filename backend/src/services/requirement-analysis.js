import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { maskSensitiveText } from './sensitive-data.js';
import { generateStructuredOutput, LlmGenerationError } from './llm-generation.js';
import { embedSearchQuery, EmbeddingProviderError } from './embeddings.js';
import { RequirementAnalysisError } from './analysis-validation.js';
import { buildRequirementCandidates, validateRequirementOutput } from './requirement-extraction.js';

const MAX_INPUT_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_REQUIREMENTS = 30;
const MAX_FINDINGS = 30;
const TYPES = ['AMBIGUITY', 'INCOMPLETENESS', 'QUALITY', 'CONSISTENCY', 'CONFLICT', 'CLASSIFICATION', 'CLARIFICATION'];
const CLASSIFICATIONS = ['functional', 'non_functional', 'business_rule', 'constraint', 'security', 'other'];
const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH'];
const requirementItemsSchema = { type: 'array', maxItems: MAX_REQUIREMENTS, items: {
  type: 'object', additionalProperties: false, properties: {
    candidateId: { type: 'string', minLength: 1, maxLength: 64 },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence is a decimal number from 0.0 to 1.0, never a percentage. 100% = 1.0, 90% = 0.9, 75% = 0.75. Valid examples: 0.0, 0.5, 0.85, 0.95, 1.0. Invalid examples: 50, 75, 90, 100.' },
  }, required: ['candidateId', 'confidence'],
} };
const findingsSchema = { type: 'array', maxItems: MAX_FINDINGS, items: {
  type: 'object', additionalProperties: false, properties: {
    requirementId: { type: 'string', minLength: 1, maxLength: 64 },
    relatedRequirementId: { type: ['string', 'null'], maxLength: 64 },
    findingType: { type: 'string', enum: TYPES },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    evidenceText: { type: 'string', minLength: 1, maxLength: 180 },
    relatedEvidenceText: { type: ['string', 'null'], maxLength: 180 },
    severity: { type: 'string', enum: SEVERITIES },
    clarificationQuestion: { type: ['string', 'null'], maxLength: 240 },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'A decimal confidence from 0 to 1 for this analysis finding.' },
  }, required: ['requirementId', 'findingType', 'description', 'evidenceText', 'severity', 'clarificationQuestion', 'confidence'],
} };
const requirementsSchema = {
  type: 'object', additionalProperties: false,
  properties: { requirements: requirementItemsSchema }, required: ['requirements'],
};
const analysisSchema = {
  type: 'object', additionalProperties: false,
  properties: { findings: findingsSchema }, required: ['findings'],
};
const classificationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    classifications: { type: 'array', maxItems: MAX_REQUIREMENTS, items: { type: 'object', additionalProperties: false, properties: {
      requirementId: { type: 'string', minLength: 1, maxLength: 64 },
      classification: { type: 'string', enum: CLASSIFICATIONS },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'A JSON number from 0.0 to 1.0, never a percentage.' },
    }, required: ['requirementId', 'classification', 'confidence'] } },
  }, required: ['classifications'],
};

const extractionSystemPrompt = `Requirements Extraction phase of the Requirements Intelligence agent. Select up to ${MAX_REQUIREMENTS} supplied source candidates that express a desired capability, obligation, constraint, business rule, or quality expectation. Exclude ordinary descriptive facts, interview notes, examples, background narrative, and statements that merely report events or current state without specifying desired behavior. A requirement need not use formal words such as shall or must, but it must express an expectation or constraint. Return only candidateId and extraction confidence. Do not classify requirements. Do not return requirement text, source evidence, offsets, canonical requirement IDs, priority, or assumptions; the backend resolves all source metadata and IDs from the selected candidate. Select only IDs in the supplied candidate list. Confidence MUST be a decimal JSON number from 0 to 1, never a percentage. Return only JSON matching the supplied schema.`;
const analysisSystemPrompt = `Requirements Quality Analysis. Check ambiguity, incompleteness, inconsistency/conflict, duplication, infeasibility, testability, undefined terminology, conflicting expectations, and clarification needs. Analyze each supplied requirement independently for intrinsic issues using its exact requirementText, then compare requirements for direct contradictions and duplicate obligations. For a direct conflict or duplicate, return one finding containing both requirementId/evidenceText and relatedRequirementId/relatedEvidenceText; cite exact local text for both requirements. Use CONFLICT for incompatible rules and CONSISTENCY for substantially duplicated obligations. A finding must describe an issue actually present in that requirement and include evidenceText: a short, verbatim, case-sensitive substring of that same requirementText. Never transfer an issue between requirements or use another requirement as evidence. Do not attach a finding because another requirement shares a domain, actor, workflow, vocabulary, or related concept. A duplicate means substantially the same obligation; shared domain, actors, workflow, or vocabulary alone is not enough. Related, dependent, and complementary requirements are not duplicates. Use AMBIGUITY for vague or unmeasurable wording such as “fast”; do not label it INCOMPLETENESS solely because no numeric target is stated. Use INCOMPLETENESS only when information genuinely needed to understand, implement, verify, or test the stated behavior is absent, such as a necessary actor, trigger/condition, timing, expected outcome, or business constraint. “The system shall notify users” may need its trigger or timing clarified when necessary to verify the behavior. Testability concerns observable behavior, not implementation choices. When the requirement already says an actor shall display, record, upload, assign, or maintain something, do not ask how that stated action is implemented unless the missing detail changes the observable behavior or a stated constraint. Do not invent additional notifications, security rules, or other obligations absent from the supplied text. Do not call a requirement incomplete merely because it omits database technology, programming language, API design, algorithms, internal modules, deployment, framework, hardware, or exact UI details unless the requirement itself makes that detail necessary. Do not infer authentication or other security requirements solely from general engineering best practices. If a requirement has no meaningful issue, return no finding for it. Do not invent missing text or requirements. Never say requirement text is missing when it is present. Name the specific missing criterion when a real omission affects quality. Avoid generic findings. Return a flat findings array; each item contains only requirementId, findingType, description, evidenceText, severity, clarificationQuestion (genuine question or null), and confidence from 0 to 1. Use only supplied IDs. Do not return generated requirement text, source evidence, offsets, or other metadata. Do not classify requirements or assess security, privacy, risk, or policy. Return findings: [] when no supported issue exists.`;
const classificationSystemPrompt = `Classify each requirement by semantic purpose. FUNCTIONAL describes a system behavior or capability. NON_FUNCTIONAL describes a quality attribute or measurable property, including performance, availability, reliability, usability, scalability, maintainability, response time, or capacity. BUSINESS_RULE describes a business policy, condition, eligibility, calculation, approval, or domain rule. CONSTRAINT describes an externally imposed implementation, technology, platform, interface, legal, organizational, architectural, or operational limit. SECURITY describes authentication, authorization, access control, confidentiality, integrity, secure handling, security monitoring, or fraud/security protection. OTHER is only for requirements that do not reasonably fit those classes. Return exactly one classification for every supplied requirement. Do not omit, duplicate, or invent requirement IDs. Classify according to semantic purpose. Return only the requested JSON.`;

export function createRequirementAnalysisService({ database = pool, generateOutput = generateStructuredOutput, embedQuery = embedSearchQuery } = {}) {
  return async function runIntelligence(projectId, inputId) {
    let project, input;
    try {
      const p = await database.query('SELECT id,name,selected_domain FROM projects WHERE id=$1', [projectId]);
      project = p.rows[0];
      if (!project) throw new RequirementAnalysisError('Project not found.', 'PROJECT_NOT_FOUND', 404);
      const i = await database.query(`SELECT id,project_id,input_type,title,source,original_filename,processing_status,submitted_content,extracted_text FROM project_inputs WHERE id=$1 AND project_id=$2`, [inputId, projectId]);
      input = i.rows[0];
      if (!input) throw new RequirementAnalysisError('Input was not found in this project.', 'INPUT_NOT_FOUND', 404);
      if (input.processing_status !== 'READY') throw new RequirementAnalysisError('Only READY project inputs can be analyzed.', 'INPUT_NOT_READY', 409);
    } catch (error) { if (error instanceof RequirementAnalysisError) throw error; throw databaseFailure(); }
    const sourceText = input.input_type === 'DOCUMENT' ? input.extracted_text : input.submitted_content;
    if (!sourceText?.trim()) throw new RequirementAnalysisError('The READY input has no text available for analysis.', 'SOURCE_INPUT_EMPTY', 422);
    if (sourceText.length > MAX_INPUT_CHARS) throw new RequirementAnalysisError(`Input is ${sourceText.length} characters; the safe limit is ${MAX_INPUT_CHARS}. Split it into smaller inputs.`, 'INTELLIGENCE_INPUT_TOO_LARGE', 413);
    // Other source inputs do not consume this source's analysis context.
    const requirementsContext = [];
    let provider = { provider: 'unknown', model: 'unknown' };
    const generationOptions = { provider: config.generation.provider, fallbacks: [], retryAttempts: 1, timeoutMillis: config.generation.timeoutMillis, onProviderUsed: (value) => { provider = value; } };
    const generateStage = async (request) => {
      try { return await generateOutput(request, generationOptions); }
      catch (error) { if (error instanceof LlmGenerationError) throw error; throw new LlmGenerationError('The configured LLM provider could not complete Requirements Intelligence.', 'LLM_PROVIDER_UNAVAILABLE', 503); }
    };

    const candidates = buildRequirementCandidates(sourceText, input.id);
    const extractionContext = { project: { domain: maskSensitiveText(project.selected_domain) }, input: { id: input.id, title: maskSensitiveText(input.title) }, candidates: candidates.map(({ candidateId, requirementText }) => ({ candidateId, text: maskSensitiveText(requirementText) })) };
    const extractionUserPrompt = `Select up to ${MAX_REQUIREMENTS} candidate IDs that express requirements. Return candidateId and confidence only; do not classify.\n<context>${JSON.stringify(extractionContext)}\n</context>`;
    if (extractionUserPrompt.length > MAX_CONTEXT_CHARS) throw new RequirementAnalysisError(`Prepared context is ${extractionUserPrompt.length} characters; safe limit is ${MAX_CONTEXT_CHARS}. Reduce the input or candidate set.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const rawRequirements = await generateStage({ systemPrompt: extractionSystemPrompt, userPrompt: extractionUserPrompt, responseSchema: requirementsSchema, modelPurpose: 'requirements-intelligence', maxTokens: 2800 });
    let extracted;
    try { extracted = validateRequirementsOutput(rawRequirements, sourceText, candidates, input.id); }
    catch (error) { logValidationRejection(error, 'requirement-extraction'); throw error; }

    const queryText = maskSensitiveText(`${project.selected_domain || ''} ${input.title} ${sourceText.slice(0, 1400)} security privacy risk policy compliance`);
    let kbEvidence = [];
    try {
      const vector = await embedQuery(queryText);
      const found = await database.query(`SELECT c.id AS chunk_id,d.id AS document_id,d.title,d.source,d.authority,d.document_type,d.tags,c.chunk_text,1-(c.embedding <=> $1::vector) AS similarity FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.knowledge_document_id WHERE d.processing_status='READY' AND 1-(c.embedding <=> $1::vector) >= $2 ORDER BY c.embedding <=> $1::vector LIMIT $3`, [`[${vector.join(',')}]`, config.knowledge.minSimilarity, Math.min(config.knowledge.maxSearchTopK, 5)]);
      kbEvidence = found.rows.map((row) => ({ chunkId: row.chunk_id, documentId: row.document_id, title: row.title, source: row.source, authority: row.authority, documentType: row.document_type, tags: row.tags, text: row.chunk_text, similarity: Number(row.similarity) }));
    } catch (error) { if (!(error instanceof EmbeddingProviderError)) throw databaseFailure(); /* no retrieval evidence is an explicit state */ }
    kbEvidence = kbEvidence.map((entry) => ({ ...entry, text: entry.text.slice(0, 250) }));
    const analysisContext = { requirements: extracted.requirements.map(({ key, requirementText }) => ({ requirementId: key, requirementText: maskSensitiveText(requirementText) })) };
    const retrievedEvidenceContext = kbEvidence.map((item) => ({ ...item, title: maskSensitiveText(item.title), source: maskSensitiveText(item.source), authority: maskSensitiveText(item.authority), text: maskSensitiveText(item.text) }));
    const analysisUserPrompt = `Analyze each listed requirement independently against its exact requirementText. If you report an issue, copy a short evidenceText substring verbatim from that same text and use that item's requirementId. Do not use text or issues from another requirement. Return one flat finding per supported issue only, with requirementId, findingType, description, evidenceText, relatedRequirementId (null for a single-requirement issue), relatedEvidenceText (null for a single-requirement issue), severity, clarificationQuestion (or null), and confidence from 0 to 1. For direct conflicts or duplicates, cite a second supplied requirement ID and a short exact substring from it. For duplicate relationships, report the same relationship against each involved requirement with evidence local to each. Retrieved knowledge below is separate, contextual, and non-authoritative. It may inform clarification, but do not infer a requirement or binding regulatory conclusion from it.\n<retrieved_knowledge_evidence>${JSON.stringify(retrievedEvidenceContext)}</retrieved_knowledge_evidence>\n<context>${JSON.stringify(analysisContext)}\n</context>`;
    if (analysisUserPrompt.length > MAX_CONTEXT_CHARS) throw new RequirementAnalysisError(`Prepared context is ${analysisUserPrompt.length} characters; safe limit is ${MAX_CONTEXT_CHARS}. Reduce the input or candidate set.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const rawAnalysis = await generateStage({ systemPrompt: analysisSystemPrompt, userPrompt: analysisUserPrompt, responseSchema: analysisSchema, modelPurpose: 'requirements-intelligence', maxTokens: 3500 });
    let analysis;
    try { analysis = validateAnalysisOutput(rawAnalysis, sourceText, extracted.requirements, requirementsContext, kbEvidence); deduplicateClarificationQuestions(analysis.findings); }
    catch (error) { logValidationRejection(error, 'requirement-analysis'); throw error; }

    const classificationContext = {
      requirements: extracted.requirements.map(({ key, requirementText }) => ({ requirementId: key, requirementText: maskSensitiveText(requirementText) })),
    };
    const classificationUserPrompt = `Return exactly one classification for each of the ${classificationContext.requirements.length} supplied requirements. Use each supplied requirementId exactly once. Do not omit, duplicate, or invent requirement IDs. Classify according to semantic purpose. Return only the requested JSON.\n<context>${JSON.stringify(classificationContext)}\n</context>`;
    if (classificationUserPrompt.length > MAX_CONTEXT_CHARS) throw new RequirementAnalysisError(`Prepared context is ${classificationUserPrompt.length} characters; safe limit is ${MAX_CONTEXT_CHARS}. Reduce the input or candidate set.`, 'INTELLIGENCE_CONTEXT_TOO_LARGE', 413);
    const rawClassification = await generateStage({ systemPrompt: classificationSystemPrompt, userPrompt: classificationUserPrompt, responseSchema: buildClassificationSchema(extracted.requirements), modelPurpose: 'requirements-intelligence', maxTokens: 2400 });
    let classification;
    try { classification = validateClassificationOutput(rawClassification, extracted.requirements); }
    catch (error) { logValidationRejection(error, 'requirement-classification'); throw error; }
    for (const requirement of extracted.requirements) requirement.requirementType = classification.classifications.get(requirement.key);
    for (const requirement of extracted.normalizedRequirements) requirement.requirementType = classification.classifications.get(requirement.key);

    const output = { ...analysis, securityPrivacy: [], risks: [], complianceMappings: [], requirements: extracted.requirements, normalizedRequirements: extracted.normalizedRequirements };
    return persist(database, projectId, input, output, provider, kbEvidence);
  };
}

function buildClassificationSchema(requirements) {
  const schema = JSON.parse(JSON.stringify(classificationSchema));
  const requirementIds = requirements.map((requirement) => requirement.key);
  schema.properties.classifications.minItems = requirementIds.length;
  schema.properties.classifications.maxItems = requirementIds.length;
  schema.properties.classifications.items.properties.requirementId.enum = requirementIds;
  return schema;
}

function validateRequirementsOutput(raw, sourceText, candidates, sourceInputId) {
  let out; try { out = JSON.parse(raw); } catch (error) { throw invalidOutput(`INVALID_JSON:${raw.length}:${raw.trimEnd().endsWith('}')}:${String(error.message).match(/position\s+(\d+)/i)?.[1] || 'unknown'}`); }
  if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== 1 || !Object.hasOwn(out,'requirements') || !Array.isArray(out.requirements)) throw invalidOutput('REQUIREMENTS_ROOT_OR_ARRAY_SHAPE');
  if (out.requirements.length > MAX_REQUIREMENTS || out.requirements.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw invalidOutput('ARRAY_LIMIT_OR_REQUIREMENT_SHAPE');
  const candidatesById = new Map(candidates.filter((candidate) => candidate.sourceInputId === sourceInputId).map((candidate) => [candidate.candidateId, candidate]));
  const selected = [];
  const seen = new Set();
  for (const [index, selection] of out.requirements.entries()) {
    const expectedFields = ['candidateId', 'confidence'];
    if (Object.keys(selection).length !== expectedFields.length || expectedFields.some((field) => !Object.hasOwn(selection, field))) throw invalidOutput('REQUIREMENT_CANDIDATE_SHAPE', { field: 'requirements', selectionIndex: index, validationReason: 'must contain only candidateId and confidence' });
    if (typeof selection.candidateId !== 'string') throw invalidOutput('REQUIREMENT_CANDIDATE_ID', { field: 'candidateId', selectionIndex: index, validationReason: 'must be a string' });
    const candidate = candidatesById.get(selection.candidateId);
    if (!candidate) throw invalidOutput('REQUIREMENT_CANDIDATE_ID', { field: 'candidateId', selectionIndex: index, validationReason: 'does not belong to the selected source input' });
    if (seen.has(selection.candidateId)) continue;
    seen.add(selection.candidateId);
    if (!validConfidence(selection.confidence)) throw invalidOutput('REQUIREMENT_CANDIDATE_CONFIDENCE', { field: 'confidence', selectionIndex: index, validationReason: 'must be a JSON number from 0 to 1' });
    if (!Number.isInteger(candidate.start) || !Number.isInteger(candidate.end) || candidate.start < 0 || candidate.end <= candidate.start || sourceText.slice(candidate.start, candidate.end) !== candidate.text) throw invalidOutput('REQUIREMENT_CANDIDATE_SOURCE_SPAN', { field: 'candidateId', selectionIndex: index, validationReason: 'candidate no longer matches its authoritative source span' });
    selected.push({ candidate, confidence: selection.confidence });
  }
  let newReq = [];
  try {
    newReq = selected.map(({ candidate, confidence }) => {
      const requirementText = candidate.requirementText || candidate.text;
      if (typeof requirementText !== 'string' || !requirementText.trim() || requirementText.length > 3000) throw invalidOutput('CANDIDATE_REQUIREMENT_TEXT');
      return { requirementText, requirementType: 'UNKNOWN', priority: explicitSourcePriority(requirementText), sourceEvidence: candidate.text, sourceEvidenceStart: candidate.start, sourceEvidenceEnd: candidate.end, confidence, assumptions: [] };
    });
  } catch (error) { const wrapped=invalidOutput(`REQUIREMENT_${error.diagnosticReason || 'VALIDATION'}`); wrapped.diagnosticDetail=error.diagnosticDetail; throw wrapped; }
  assignCanonicalRequirementKeys(newReq, []);
  return { requirements: newReq, normalizedRequirements: newReq };
}

function validateAnalysisOutput(raw, sourceText, requirements, known) {
  let out; try { out = JSON.parse(raw); } catch (error) { throw invalidOutput(`INVALID_JSON:${raw.length}:${raw.trimEnd().endsWith('}')}:${String(error.message).match(/position\s+(\d+)/i)?.[1] || 'unknown'}`); }
  if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== 1 || !Array.isArray(out.findings)) throw invalidOutput('ANALYSIS_ROOT_OR_ARRAY_SHAPE');
  if (out.findings.length > MAX_FINDINGS) throw invalidOutput('ARRAY_LIMIT_OR_FINDING_SHAPE');
  const idMap = new Map(known.map((r) => [r.key,r]));
  requirements.forEach((r,i) => { if (r.key !== `N${i+1}` || idMap.has(r.key)) throw invalidOutput('REQUIREMENT_KEY_SEQUENCE'); idMap.set(r.key, r); });
  const authoritativeEvidence = new Map([...known.map((r) => [r.key,r.sourceEvidence]), ...requirements.map((r) => [r.key,r.sourceEvidence])]);
  const authoritativeRequirementText = new Map([...known.map((r) => [r.key,r.requirementText]), ...requirements.map((r) => [r.key,r.requirementText])]);
  const validated = [];
  const seen = new Set();
  for (const f of out.findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.requirementId !== 'string' || !idMap.has(f.requirementId) ||
        !TYPES.includes(f.findingType) || !SEVERITIES.includes(f.severity) || !shortText(f.description,500)) continue;
    const requirement = idMap.get(f.requirementId);
    if (shortText(requirement.requirementText, 3000) && claimsRequirementTextMissing(f)) continue;
    const maskedRequirement = maskSensitiveText(requirement.requirementText);
    if (typeof f.evidenceText !== 'string' || !f.evidenceText.trim() || f.evidenceText.length > 180 || !maskedRequirement.includes(f.evidenceText)) continue;
    const quote = authoritativeEvidence.get(f.requirementId);
    if (typeof quote !== 'string' || !quote.length || !maskSensitiveText(quote).includes(f.evidenceText) || !Number.isInteger(requirement.sourceEvidenceStart) || !Number.isInteger(requirement.sourceEvidenceEnd) || sourceText.slice(requirement.sourceEvidenceStart, requirement.sourceEvidenceEnd) !== quote) continue;
    const clarificationQuestion = typeof f.clarificationQuestion === 'string' && shortText(f.clarificationQuestion,240) && f.clarificationQuestion.trim().endsWith('?') ? f.clarificationQuestion.trim() : null;
    if (!validConfidence(f.confidence)) continue;
    const isRelationship = ['CONFLICT','CONSISTENCY'].includes(f.findingType);
    const relatedId = typeof f.relatedRequirementId === 'string' ? f.relatedRequirementId : null;
    const relatedRequirement = relatedId ? idMap.get(relatedId) : null;
    if (isRelationship && (!relatedRequirement || relatedId === f.requirementId || !shortText(f.relatedEvidenceText,180))) continue;
    if (!isRelationship && (relatedId !== null || (f.relatedEvidenceText !== undefined && f.relatedEvidenceText !== null))) continue;
    if (relatedRequirement && !maskSensitiveText(relatedRequirement.requirementText).includes(f.relatedEvidenceText)) continue;
    const relatedQuote = relatedId ? authoritativeEvidence.get(relatedId) : null;
    if (relatedId && (typeof relatedQuote !== 'string' || !maskSensitiveText(relatedQuote).includes(f.relatedEvidenceText)
        || !Number.isInteger(relatedRequirement.sourceEvidenceStart) || !Number.isInteger(relatedRequirement.sourceEvidenceEnd)
        || sourceText.slice(relatedRequirement.sourceEvidenceStart,relatedRequirement.sourceEvidenceEnd) !== relatedQuote)) continue;
    const requirementIds = relatedId ? [f.requirementId, relatedId] : [f.requirementId];
    const identity = JSON.stringify([requirementIds.slice().sort(),f.findingType,f.severity,f.description.trim()]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    validated.push({
      findingType:f.findingType, severity:f.severity, title:makeFindingTitle(f.findingType,f.description), description:f.description.trim(),
      requirementIds, requirementReferences:requirementIds.map((requirementId)=>({requirementId,requirementText:authoritativeRequirementText.get(requirementId)})),
      evidence:requirementIds.map((requirementId)=>({requirementId,quote:authoritativeEvidence.get(requirementId)})), clarificationQuestion, confidence:f.confidence,
      requirementText:requirement.requirementText,
    });
  }
  const combinedFindings = combineRelationshipFindings(validated);
  for (const f of combinedFindings) {
    f.requirementReferences=f.requirementIds.map((requirementId)=>({requirementId,requirementText:authoritativeRequirementText.get(requirementId)}));
    f.evidence=f.requirementIds.map((requirementId)=>({requirementId,quote:authoritativeEvidence.get(requirementId)}));
  }
  return {findings:combinedFindings};
}

function claimsRequirementTextMissing(finding) {
  const claim = `${finding.description || ''} ${finding.clarificationQuestion || ''}`.toLowerCase();
  return /\b(?:the\s+)?(?:requirement|source)\s+(?:text|wording|statement)\s+(?:(?:is|was|appears to be|seems to be)\s+)?(?:missing|absent|unavailable|not\s+(?:provided|present|available|included|supplied))\b/.test(claim)
    || /\b(?:missing|absent|unavailable)\s+(?:requirement|source)\s+(?:text|wording|statement)\b/.test(claim)
    || /\bno\s+(?:requirement|source)\s+(?:text|wording|statement)\b/.test(claim)
    || /\b(?:text|wording|statement)\s+(?:for|of)\s+(?:the\s+)?requirement\s+(?:(?:is|was)\s+)?(?:missing|absent|unavailable|not\s+(?:provided|present|available|included|supplied))\b/.test(claim);
}

function validateClassificationOutput(raw, requirements) {
  let out; try { out = JSON.parse(raw); } catch (error) { throw invalidOutput(`INVALID_JSON:${raw.length}:${raw.trimEnd().endsWith('}')}:${String(error.message).match(/position\s+(\d+)/i)?.[1] || 'unknown'}`); }
  if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== 1 || !Object.hasOwn(out,'classifications') || !Array.isArray(out.classifications)) throw invalidOutput('CLASSIFICATION_ROOT_OR_ARRAY_SHAPE');
  if (out.classifications.length !== requirements.length) throw invalidOutput('CLASSIFICATION_ARRAY_LIMIT_OR_COVERAGE');
  const requirementById = new Map(requirements.map((requirement)=>[requirement.key,requirement]));
  const classifications = new Map();
  for (const [index, item] of out.classifications.entries()) {
    const fields=['requirementId','classification','confidence'];
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== fields.length || fields.some((field)=>!Object.hasOwn(item,field))) throw invalidOutput('CLASSIFICATION_ITEM_SHAPE',{field:'classifications',selectionIndex:index,validationReason:'must contain only requirementId, classification, and confidence'});
    if (typeof item.requirementId !== 'string' || !requirementById.has(item.requirementId)) throw invalidOutput('CLASSIFICATION_REQUIREMENT_ID',{field:'requirementId',selectionIndex:index,validationReason:'does not belong to the current extracted requirements'});
    if (classifications.has(item.requirementId)) throw invalidOutput('CLASSIFICATION_DUPLICATE_REQUIREMENT_ID',{field:'requirementId',selectionIndex:index,validationReason:'each requirement must be classified exactly once'});
    if (!CLASSIFICATIONS.includes(item.classification)) throw invalidOutput('CLASSIFICATION_TYPE',{field:'classification',selectionIndex:index,validationReason:'must be one of the allowed primary classifications'});
    if (!validConfidence(item.confidence)) throw invalidOutput('CLASSIFICATION_CONFIDENCE',{field:'confidence',selectionIndex:index,validationReason:'must be a JSON number from 0 to 1'});
    classifications.set(item.requirementId,item.classification.toUpperCase());
  }
  if (classifications.size !== requirementById.size || [...requirementById.keys()].some((id)=>!classifications.has(id))) throw invalidOutput('CLASSIFICATION_REQUIREMENT_COVERAGE');
  return {classifications};
}

function makeFindingTitle(type, description) { return `${type}: ${description}`.slice(0,120); }
function combineRelationshipFindings(findings) {
  const result=[], grouped=new Map();
  for (const finding of findings) {
    if (!['CONFLICT','CONSISTENCY'].includes(finding.findingType)) { result.push(finding); continue; }
    // The model may describe a pair once from each side, with different wording.
    // One relationship is still one finding; preserve the first grounded record.
    const key=JSON.stringify([finding.findingType,finding.severity,[...finding.requirementIds].sort()]);
    const group=grouped.get(key);
    if (group) { for (const requirementId of finding.requirementIds) if (!group.requirementIds.includes(requirementId)) group.requirementIds.push(requirementId); }
    else grouped.set(key,{...finding,requirementIds:[...new Set(finding.requirementIds)]});
  }
  for (const finding of grouped.values()) if (finding.requirementIds.length>=2) result.push(finding);
  return result.slice(0,MAX_FINDINGS);
}
function assignCanonicalRequirementKeys(requirements, known) {
  const existingKeys = new Set(known.map((r) => r.key));
  requirements.forEach((requirement, index) => {
    const key = `N${index + 1}`;
    if (existingKeys.has(key)) throw invalidOutput('REQUIREMENT_KEY_SEQUENCE');
    requirement.key = key;
  });
}

function explicitSourcePriority(text) {
  const match = text.match(/\b(?:priority\s*[:=]?\s*(HIGH|MEDIUM|LOW)|(HIGH|MEDIUM|LOW)\s+priority)\b/i);
  return match ? (match[1] || match[2]).toUpperCase() : null;
}

function logValidationRejection(error, stage) {
  if (error instanceof RequirementAnalysisError) console.warn('Requirements Intelligence output rejected.', { stage, diagnosticReason: error.diagnosticReason || 'OUTPUT_VALIDATION', ...(error.diagnosticDetail ? { diagnosticDetail: error.diagnosticDetail } : {}) });
}

async function persist(database, projectId, input, out, provider, kb) {
  const client = await database.connect(); const runId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    await client.query('DELETE FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2', [projectId,input.id]);
    const saved = new Map();
    const requirements = [];
    for (let i=0; i<out.normalizedRequirements.length; i++) {
      const r = out.normalizedRequirements[i];
      const row = (await client.query(`INSERT INTO candidate_requirements (project_id,source_input_id,requirement_text,requirement_type,priority,source_evidence,source_evidence_start,source_evidence_end,confidence,assumptions,extraction_status,generation_provider,generation_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'COMPLETED',$11,$12) RETURNING *`, [projectId,input.id,r.requirementText,r.requirementType,r.priority,r.sourceEvidence,r.sourceEvidenceStart,r.sourceEvidenceEnd,r.confidence,r.assumptions,provider.provider,provider.model])).rows[0];
      saved.set(out.requirements[i].key,row.id); requirements.push(row);
    }
    const allIds = requirements.map((r)=>r.id).sort();
    const mappedFindings = out.findings.map((f) => ({ ...f, requirementIds: f.requirementIds.map((key) => saved.get(key)), evidence:f.evidence.map((item)=>({...item,requirementId:saved.get(item.requirementId)})), id: randomUUID() }));
    const summary = { requirementsWithFindings: [...new Set(mappedFindings.flatMap((f) => f.requirementIds))], requirementsWithoutFindings: allIds.filter((id) => !mappedFindings.some((f) => f.requirementIds.includes(id))), findingsByType: countBy(mappedFindings,'findingType'), findingsBySeverity: countBy(mappedFindings,'severity'), clarificationQuestions: mappedFindings.filter((f) => f.clarificationQuestion).map((f) => ({ findingId:f.id, requirementIds:f.requirementIds, question:f.clarificationQuestion })), intelligence: { securityPrivacy: [], risks: [], complianceMappings: [], knowledgeEvidence: kb, generatedAt: new Date().toISOString() } };
    await client.query('DELETE FROM requirement_analysis_runs WHERE project_id=$1 AND source_input_id=$2',[projectId,input.id]);
    await client.query(`INSERT INTO requirement_analysis_runs (id,project_id,source_input_id,requirement_ids,status,provider,model_name,provider_metadata,requirement_count,finding_count,summary) VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6,$7::jsonb,$8,$9,$10::jsonb)`, [runId,projectId,input.id,allIds,provider.provider,provider.model,JSON.stringify(provider),allIds.length,mappedFindings.length,JSON.stringify(summary)]);
    for (const f of mappedFindings) await client.query(`INSERT INTO requirement_analysis_findings (id,analysis_run_id,requirement_ids,agent_names,finding_type,severity,title,description,evidence,clarification_question,confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`, [f.id,runId,f.requirementIds,['Requirements Intelligence Agent'],f.findingType,f.severity,f.title,f.description,JSON.stringify(f.evidence),f.clarificationQuestion,f.confidence]);
    await client.query('COMMIT');
    return { sourceInputId:input.id, requirements: requirements.map((r) => ({ id:r.id, projectId:r.project_id, sourceInputId:r.source_input_id, requirementText:r.requirement_text, requirementType:r.requirement_type, priority:r.priority, sourceEvidence:r.source_evidence, sourceEvidenceStart:r.source_evidence_start, sourceEvidenceEnd:r.source_evidence_end, confidence:Number(r.confidence), assumptions:r.assumptions, extractionStatus:r.extraction_status, provider:r.generation_provider, modelName:r.generation_model })), sourceInput:{id:input.id,title:input.title,source:input.source,inputType:input.input_type,originalFilename:input.original_filename}, provider:provider.provider, modelName:provider.model, ...await loadCurrentProjectAnalysis(database,projectId,input.id) };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error instanceof RequirementAnalysisError ? error : databaseFailure(); }
  finally { client.release(); }
}

function deduplicateClarificationQuestions(findings) { const seen=new Set(); for (const finding of findings) { if (!finding.clarificationQuestion) continue; const question=finding.clarificationQuestion.trim(); if (seen.has(question)) finding.clarificationQuestion=null; else seen.add(question); } }
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

export async function loadCurrentProjectAnalysis(database, projectId, sourceInputId) {
  const project = await database.query('SELECT id FROM projects WHERE id=$1',[projectId]);
  if (!project.rowCount) throw new RequirementAnalysisError('Project not found.','PROJECT_NOT_FOUND',404);
  if (!sourceInputId) throw new RequirementAnalysisError('A sourceInputId is required to load Requirements Intelligence results.','VALIDATION_ERROR',400);
  const source=await database.query('SELECT id FROM project_inputs WHERE id=$1 AND project_id=$2',[sourceInputId,projectId]);
  if (!source.rowCount) throw new RequirementAnalysisError('Input was not found in this project.','INPUT_NOT_FOUND',404);
  const [runs,candidates] = await Promise.all([database.query('SELECT * FROM requirement_analysis_runs WHERE project_id=$1 AND source_input_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[projectId,sourceInputId]),database.query('SELECT id FROM candidate_requirements WHERE project_id=$1 AND source_input_id=$2 ORDER BY id',[projectId,sourceInputId])]);
  const row=runs.rows[0]; if(!row) return {sourceInputId,analysis:null,findings:[]};
  const ids=candidates.rows.map(x=>x.id).sort(); if(ids.length!==row.requirement_ids.length||ids.some((id,i)=>id!==[...row.requirement_ids].sort()[i])) return {sourceInputId,analysis:null,findings:[]};
  const rows=await database.query('SELECT * FROM requirement_analysis_findings WHERE analysis_run_id=$1 ORDER BY created_at,id',[row.id]);
  const currentIds=new Set(ids);
  const findings=rows.rows.filter((finding)=>finding.requirement_ids.length&&finding.requirement_ids.every((id)=>currentIds.has(id))).map((r)=>({id:r.id,analysisRunId:r.analysis_run_id,requirementIds:r.requirement_ids,agentNames:r.agent_names,findingType:r.finding_type,severity:r.severity,title:r.title,description:r.description,evidence:r.evidence,clarificationQuestion:r.clarification_question,confidence:Number(r.confidence),createdAt:r.created_at}));
  return {sourceInputId,analysis:{id:row.id,projectId:row.project_id,sourceInputId:row.source_input_id,requirementIds:row.requirement_ids,status:row.status,provider:row.provider,modelName:row.model_name,providerByAgent:row.provider_metadata,requirementCount:row.requirement_count,findingCount:findings.length,summary:row.summary,createdAt:row.created_at},findings};
}
