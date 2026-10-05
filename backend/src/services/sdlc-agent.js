import { config } from '../config.js';
import { generateStructuredOutput } from './llm-generation.js';
import { maskSensitiveText } from './sensitive-data.js';

const METHODS = ['AGILE', 'INCREMENTAL', 'SPIRAL', 'V_MODEL', 'WATERFALL', 'PROTOTYPING', 'RAD', 'DEVSECOPS'];
const factorNames = ['requirementStability', 'requirementClarity', 'projectRisk', 'complexity', 'prototypeNeed', 'timePressure', 'stakeholderInvolvement', 'expectedChange', 'iterativeNeed', 'riskAnalysisNeed'];
const explanationSchema = { type: 'object', additionalProperties: false, properties: {
  relevantFactors: { type: 'array', minItems: 2, maxItems: 4, uniqueItems: true, items: { type: 'string', enum: factorNames } },
}, required: ['relevantFactors'] };

export function calculateProjectFactors(project, requirements, findings) {
  const texts = requirements.map((item) => item.requirement_text.toLowerCase());
  const allText = texts.join(' ');
  const unresolved = findings.filter((item) => ['HIGH', 'MEDIUM'].includes(item.severity)).length;
  const count = Math.max(1, requirements.length);
  const score = (value) => Math.max(1, Math.min(5, Math.round(value)));
  return {
    requirementStability: score(4 - unresolved / count * 2),
    requirementClarity: score(4.5 - unresolved / count * 2.5),
    projectRisk: score(2 + requirements.filter((item) => item.requirement_type === 'SECURITY' || item.requirement_type === 'BUSINESS_RULE').length / count * 2 + unresolved / count),
    complexity: score(1 + Math.log2(count + 1)),
    prototypeNeed: /prototype|usability|user experience|explore/.test(allText) ? 4 : 2,
    timePressure: /urgent|as soon as possible|short deadline|time critical/.test(allText) ? 5 : 3,
    stakeholderInvolvement: /review|staff|customer|applicant|analyst|stakeholder/.test(allText) ? 4 : 2,
    expectedChange: /may change|evolving|frequent change|adjustable|configurable/.test(allText) ? 5 : 3,
    iterativeNeed: /feedback|review|pilot|adjust|iterate/.test(allText) ? 4 : 3,
    riskAnalysisNeed: score(2 + requirements.filter((item) => ['SECURITY', 'BUSINESS_RULE'].includes(item.requirement_type)).length / count * 2 + unresolved / count),
  };
}

const weights = {
  AGILE: { requirementStability: -1, requirementClarity: -0.3, projectRisk: 0.3, complexity: 0.5, prototypeNeed: 0.5, timePressure: 0.7, stakeholderInvolvement: 0.8, expectedChange: 1, iterativeNeed: 1, riskAnalysisNeed: 0.2 },
  INCREMENTAL: { requirementStability: 0.2, requirementClarity: 0.4, projectRisk: 0.4, complexity: 0.8, prototypeNeed: 0.3, timePressure: 0.5, stakeholderInvolvement: 0.4, expectedChange: 0.5, iterativeNeed: 0.8, riskAnalysisNeed: 0.4 },
  SPIRAL: { requirementStability: -0.2, requirementClarity: -0.2, projectRisk: 1, complexity: 0.7, prototypeNeed: 0.5, timePressure: -0.2, stakeholderInvolvement: 0.4, expectedChange: 0.4, iterativeNeed: 0.4, riskAnalysisNeed: 1 },
  V_MODEL: { requirementStability: 0.9, requirementClarity: 1, projectRisk: 0.8, complexity: 0.5, prototypeNeed: -0.5, timePressure: -0.4, stakeholderInvolvement: 0.2, expectedChange: -0.8, iterativeNeed: -0.7, riskAnalysisNeed: 0.8 },
  WATERFALL: { requirementStability: 1, requirementClarity: 0.9, projectRisk: -0.2, complexity: 0.1, prototypeNeed: -0.8, timePressure: -0.5, stakeholderInvolvement: -0.3, expectedChange: -1, iterativeNeed: -0.8, riskAnalysisNeed: -0.2 },
  PROTOTYPING: { requirementStability: -0.6, requirementClarity: -0.8, projectRisk: -0.1, complexity: 0.3, prototypeNeed: 1, timePressure: 0.4, stakeholderInvolvement: 0.8, expectedChange: 0.7, iterativeNeed: 0.7, riskAnalysisNeed: -0.2 },
  RAD: { requirementStability: -0.4, requirementClarity: 0.1, projectRisk: -0.4, complexity: -0.3, prototypeNeed: 0.8, timePressure: 1, stakeholderInvolvement: 0.8, expectedChange: 0.4, iterativeNeed: 0.4, riskAnalysisNeed: -0.5 },
  DEVSECOPS: { requirementStability: -0.1, requirementClarity: 0.3, projectRisk: 0.8, complexity: 0.4, prototypeNeed: 0.1, timePressure: 0.6, stakeholderInvolvement: 0.3, expectedChange: 0.6, iterativeNeed: 0.7, riskAnalysisNeed: 1 },
};

export function rankSdlcApproaches(factors) {
  return METHODS.map((method) => {
    const score = Object.entries(weights[method]).reduce((total, [factor, weight]) => total + (factors[factor] - 3) * weight, 0);
    return { method, score: Number(score.toFixed(3)) };
  }).sort((a, b) => b.score - a.score || a.method.localeCompare(b.method));
}

export function buildSdlcWorkflow(method, requirements) {
  const ids = requirements.map((item) => item.id);
  const stages = method === 'V_MODEL'
    ? ['Requirements baseline and acceptance criteria', 'Architecture and interface design', 'Implementation with peer review', 'Unit and integration verification', 'System validation and stakeholder sign-off']
    : method === 'SPIRAL'
      ? ['Set objectives and constraints', 'Identify and assess project risks', 'Build and evaluate the next increment', 'Review results with stakeholders and plan the next cycle']
      : ['Prioritize approved requirements and define a thin delivery increment', 'Design and implement the increment with security and data controls considered', 'Verify behavior against source-linked acceptance criteria', 'Review with stakeholders and record changes', 'Release the increment and update traceability and risks'];
  return stages.map((activity, index) => ({ order: index + 1, activity, requirementIds: ids }));
}

export function buildSdlcArtefacts(project, requirements, workflow) {
  const reqRows = requirements.map((item) => ({ requirementId: item.id, type: item.requirement_type, text: item.requirement_text, sourceInputId: item.source_input_id, sourceEvidence: item.source_evidence, reviewStatus: item.review_status }));
  return [
    { type: 'SRS_SUMMARY', title: 'Requirements summary', content: `${project.name}\n\nAdvisory summary of ${requirements.length} source-linked candidate requirements. Each item remains subject to human review.\n\n${reqRows.map((item) => `${item.requirementId} [${item.type}] ${item.text}`).join('\n')}`, requirementIds: requirements.map((item) => item.id), status: 'DRAFT' },
    { type: 'TRACEABILITY', title: 'Source traceability', content: JSON.stringify(reqRows, null, 2), requirementIds: requirements.map((item) => item.id), status: 'DRAFT' },
    { type: 'SDLC_WORKFLOW', title: 'Project workflow', content: workflow.map((item) => `${item.order}. ${item.activity}`).join('\n'), requirementIds: requirements.map((item) => item.id), status: 'DRAFT' },
  ];
}

export async function createSdlcAnalysis({ database, projectId, generateOutput = generateStructuredOutput }) {
  const projectResult = await database.query('SELECT id,name,description,selected_domain FROM projects WHERE id=$1', [projectId]);
  if (!projectResult.rowCount) throw Object.assign(new Error('Project not found.'), { status: 404, code: 'PROJECT_NOT_FOUND' });
  const requirementsResult = await database.query("SELECT * FROM candidate_requirements WHERE project_id=$1 AND extraction_status='COMPLETED' AND review_status='APPROVED' ORDER BY created_at,id", [projectId]);
  const requirements = requirementsResult.rows;
  if (!requirements.length) throw Object.assign(new Error('Approve at least one source-linked requirement before generating the SDLC recommendation and artefacts.'), { status: 409, code: 'APPROVED_REQUIREMENTS_REQUIRED' });
  const ids = requirements.map((item) => item.id);
  const findingsResult = ids.length ? await database.query(`SELECT f.severity,f.finding_type FROM requirement_analysis_findings f JOIN requirement_analysis_runs a ON a.id=f.analysis_run_id WHERE a.project_id=$1 AND f.requirement_ids && $2::uuid[] ORDER BY f.created_at DESC`, [projectId, ids]) : { rows: [] };
  const factors = calculateProjectFactors(projectResult.rows[0], requirements, findingsResult.rows);
  const ranking = rankSdlcApproaches(factors);
  const recommendation = ranking[0].method;
  const workflow = buildSdlcWorkflow(recommendation, requirements);
  const artefacts = buildSdlcArtefacts(projectResult.rows[0], requirements, workflow);
  let provider;
  const rawExplanation = await generateOutput({
    systemPrompt: 'You are Agent 2, the SDLC and Documentation Agent. The deterministic ranking has already selected the recommendation. Select only 2 to 4 factor names from the supplied factor object that are most relevant to explaining this ranking. Return those exact factor keys in relevantFactors. Do not write prose, invent facts, or change the recommendation.',
    userPrompt: JSON.stringify({ project: { name: maskSensitiveText(projectResult.rows[0].name), domain: maskSensitiveText(projectResult.rows[0].selected_domain) }, factors, ranking, recommendation }),
    responseSchema: explanationSchema, modelPurpose: 'sdlc-explanation', maxTokens: 500,
  }, { provider: config.generation.provider, fallbacks: [], retryAttempts: 1, timeoutMillis: config.generation.timeoutMillis, onProviderUsed: (value) => { provider = value; } });
  let explanationResult;
  try { explanationResult = typeof rawExplanation === 'string' ? JSON.parse(rawExplanation) : null; } catch { /* validated below without echoing provider output */ }
  if (!explanationResult || typeof explanationResult !== 'object' || Array.isArray(explanationResult)
    || Object.keys(explanationResult).length !== 1 || !Object.hasOwn(explanationResult, 'relevantFactors')
    || !Array.isArray(explanationResult.relevantFactors) || explanationResult.relevantFactors.length < 2 || explanationResult.relevantFactors.length > 4
    || new Set(explanationResult.relevantFactors).size !== explanationResult.relevantFactors.length
    || explanationResult.relevantFactors.some((name) => !factorNames.includes(name))) {
    throw Object.assign(new Error('Configured LLM returned an invalid SDLC explanation. No analysis was saved.'), { status: 502, code: 'LLM_INVALID_RESPONSE' });
  }
  const selectedFactors = explanationResult.relevantFactors.map((name) => `${name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} ${factors[name]}/5`);
  const explanation = `${recommendation} is the deterministic top-ranked method with score ${ranking[0].score}. The configured model highlighted ${selectedFactors.join(', ')} as relevant project factors. The ranking is calculated deterministically from the approved, source-linked requirements.`;
  const modelName = provider?.model || (config.generation.provider === 'groq' ? config.generation.groqModel : config.generation.provider === 'ollama' ? config.generation.model : config.generation.geminiModel);
  const approvedSnapshot = JSON.stringify([...requirements].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, requirement_text, review_status }) => ({ id, text: requirement_text, status: review_status })));
  const saved = await database.query(`INSERT INTO sdlc_analyses(project_id,factors,ranking,recommendation,explanation,workflow,artefacts,requirement_ids,provider,model_name,is_stale)
    VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'text',requirement_text,'status',review_status) ORDER BY id)
        FROM candidate_requirements WHERE project_id=$1 AND extraction_status='COMPLETED' AND review_status='APPROVED'),'[]'::jsonb) IS DISTINCT FROM $11::jsonb)
    RETURNING *`, [projectId, factors, JSON.stringify(ranking), recommendation, explanation, JSON.stringify(workflow), JSON.stringify(artefacts), ids, provider?.provider || config.generation.provider, modelName, approvedSnapshot]);
  return presentSdlcAnalysis(saved.rows[0]);
}

export function presentSdlcAnalysis(row) {
  return { id: row.id, projectId: row.project_id, status: row.status, isStale: row.is_stale ?? false, factors: row.factors, ranking: row.ranking, recommendation: row.recommendation, explanation: row.explanation, workflow: row.workflow, artefacts: row.artefacts, requirementIds: row.requirement_ids, provider: row.provider, modelName: row.model_name, reviewNote: row.review_note, reviewedAt: row.reviewed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
