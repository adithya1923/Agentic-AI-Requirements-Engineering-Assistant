import { Router } from 'express';
import { pool } from '../db/pool.js';
import { presentRequirement } from '../services/requirement-extraction.js';
import { createRequirementAnalysisService } from '../services/requirement-analysis.js';

export function createRequirementsRouter({ database = pool, generateOutput, embedQuery } = {}) {
  const router = Router();
  const runIntelligence = createRequirementAnalysisService({ database, ...(generateOutput ? { generateOutput } : {}), ...(embedQuery ? { embedQuery } : {}) });

  router.post('/projects/:projectId/requirements/extract', async (request, response, next) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    const inputId = request.body?.inputId;
    if (!isUuid(inputId)) return sendError(response, 400, 'inputId must be a UUID.', 'VALIDATION_ERROR');
    try {
      const result = await runIntelligence(request.params.projectId, inputId);
      response.json({ data: result });
    } catch (error) {
      if (error?.status >= 400 && error?.status < 600) {
        return sendError(response, error.status, error.message, error.code || 'REQUIREMENT_EXTRACTION_FAILED');
      }
      next(error);
    }
  });

  // Legacy Phase 5 entry point now delegates to the same unified intelligence
  // operation, so extraction no longer has a separate generation provider.
  router.post('/projects/:projectId/requirements/intelligence', async (request, response) => {
    if (!isUuid(request.params.projectId) || !isUuid(request.body?.inputId)) return sendError(response, 400, 'A valid project ID and inputId are required.', 'VALIDATION_ERROR');
    try { response.json({ data: await runIntelligence(request.params.projectId, request.body.inputId) }); }
    catch (error) { if (error?.status >= 400 && error.status < 600) return sendError(response, error.status, error.message, error.code || 'REQUIREMENT_INTELLIGENCE_FAILED'); return sendError(response, 503, 'The database operation for Requirements Intelligence failed.', 'DATABASE_ERROR'); }
  });

  router.get('/projects/:projectId/requirements', async (request, response, next) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    try {
      const project = await database.query('SELECT 1 FROM projects WHERE id=$1', [request.params.projectId]);
      if (!project.rowCount) return sendError(response, 404, 'Project not found.', 'PROJECT_NOT_FOUND');
      const result = await database.query(
        `SELECT r.*, i.title AS source_input_title, i.source AS source_input_source,
           i.input_type AS source_input_type, i.original_filename AS source_input_filename
         FROM candidate_requirements r
         JOIN project_inputs i ON i.id=r.source_input_id
         WHERE r.project_id=$1
         ORDER BY r.created_at DESC, r.id`,
        [request.params.projectId],
      );
      response.json({ data: result.rows.map((row) => ({
        ...presentRequirement(row),
        sourceInput: {
          id: row.source_input_id,
          title: row.source_input_title,
          source: row.source_input_source,
          inputType: row.source_input_type,
          originalFilename: row.source_input_filename,
        },
      })) });
    } catch {
      return sendError(response, 503, 'The database operation for requirement listing failed.', 'DATABASE_ERROR');
    }
  });

  router.get('/requirements/:id', async (request, response, next) => {
    if (!isUuid(request.params.id)) return sendError(response, 400, 'Requirement ID must be a UUID.', 'VALIDATION_ERROR');
    try {
      const result = await database.query(
        `SELECT r.*, i.title AS source_input_title, i.source AS source_input_source,
           i.input_type AS source_input_type, i.original_filename AS source_input_filename
         FROM candidate_requirements r
         JOIN project_inputs i ON i.id=r.source_input_id
         WHERE r.id=$1`,
        [request.params.id],
      );
      if (!result.rows.length) return sendError(response, 404, 'Requirement not found.', 'REQUIREMENT_NOT_FOUND');
      const row = result.rows[0];
      response.json({
        data: {
          ...presentRequirement(row),
          sourceInput: {
            id: row.source_input_id,
            title: row.source_input_title,
            source: row.source_input_source,
            inputType: row.source_input_type,
            originalFilename: row.source_input_filename,
          },
        },
      });
    } catch {
      return sendError(response, 503, 'The database operation for requirement lookup failed.', 'DATABASE_ERROR');
    }
  });

  return router;
}

function sendError(response, status, message, code) {
  return response.status(status).json({ error: { message, code } });
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
