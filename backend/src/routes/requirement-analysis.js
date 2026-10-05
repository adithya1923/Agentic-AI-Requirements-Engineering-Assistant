import { Router } from 'express';
import { pool } from '../db/pool.js';
import { loadCurrentProjectAnalysis, loadClarificationAnswers, refineRequirementWithAnswer, saveClarificationAnswer } from '../services/requirement-analysis.js';
import { RequirementAnalysisError } from '../services/analysis-validation.js';

export function createRequirementAnalysisRouter({ database = pool, generateOutput, modelName } = {}) {
  const router = Router();
  router.get('/projects/:projectId/clarification-answers', async (request, response) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    try { return response.json({ data: await loadClarificationAnswers(database, request.params.projectId) }); }
    catch (error) { return respondError(response, error); }
  });
  router.post('/projects/:projectId/clarification-answers', async (request, response) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    const { findingId, analysisRunId, requirementIds, question, answer } = request.body || {};
    if (!isUuid(findingId) || !isUuid(analysisRunId) || !Array.isArray(requirementIds) || !requirementIds.length || requirementIds.some((id) => !isUuid(id))
      || typeof question !== 'string' || !question.trim() || question.length > 1000 || typeof answer !== 'string' || !answer.trim() || answer.length > 5000) {
      return sendError(response, 400, 'Provide a current clarification question, linked requirement IDs, and a non-empty answer of at most 5000 characters.', 'VALIDATION_ERROR');
    }
    try {
      return response.status(201).json({ data: await saveClarificationAnswer(database, request.params.projectId, { findingId, analysisRunId, requirementIds: [...new Set(requirementIds)], question: question.trim(), answer: answer.trim() }) });
    } catch (error) { return respondError(response, error); }
  });
  router.post('/projects/:projectId/requirements/:requirementId/refine', async (request, response) => {
    if (!isUuid(request.params.projectId) || !isUuid(request.params.requirementId) || !isUuid(request.body?.answerId)) return sendError(response, 400, 'Project, requirement, and clarification answer IDs must be UUIDs.', 'VALIDATION_ERROR');
    try { return response.json({ data: await refineRequirementWithAnswer(database, request.params.projectId, request.params.requirementId, request.body.answerId, generateOutput) }); }
    catch (error) { return respondError(response, error); }
  });
  router.get('/projects/:projectId/requirements/analysis', async (request, response) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    if (!isUuid(request.query.sourceInputId)) return sendError(response,400,'A valid sourceInputId query parameter is required.','VALIDATION_ERROR');
    try {
      const result = await loadCurrentProjectAnalysis(database, request.params.projectId, request.query.sourceInputId);
      return response.json({ data: result });
    } catch (error) {
      return respondError(response, error);
    }
  });

  router.get('/requirements/:id/analysis', async (request, response) => {
    if (!isUuid(request.params.id)) return sendError(response, 400, 'Requirement ID must be a UUID.', 'VALIDATION_ERROR');
    try {
      const candidate = await database.query(
        'SELECT id, project_id, source_input_id FROM candidate_requirements WHERE id=$1', [request.params.id],
      );
      if (!candidate.rowCount) return sendError(response, 404, 'Requirement not found.', 'REQUIREMENT_NOT_FOUND');
      const result = await loadCurrentProjectAnalysis(database, candidate.rows[0].project_id, candidate.rows[0].source_input_id);
      return response.json({
        data: {
          sourceInputId:candidate.rows[0].source_input_id,
          analysis: result.analysis,
          findings: result.findings.filter((finding) => finding.requirementIds.includes(request.params.id)),
        },
      });
    } catch (error) {
      return respondError(response, error);
    }
  });

  return router;
}

function respondError(response, error) {
  if (error instanceof RequirementAnalysisError || Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return sendError(response, error.status, error.message, error.code || 'REQUIREMENT_ANALYSIS_FAILED');
  }
  return sendError(response, 503, 'The database operation for requirement analysis failed.', 'DATABASE_ERROR');
}

function sendError(response, status, message, code) {
  return response.status(status).json({ error: { message, code } });
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
