import { Router } from 'express';
import { pool } from '../db/pool.js';
import { createRequirementExtractionService, presentRequirement, RequirementExtractionError } from '../services/requirement-extraction.js';

export function createRequirementsRouter({ database = pool, generateOutput } = {}) {
  const router = Router();
  const extractForInput = createRequirementExtractionService({ database, ...(generateOutput ? { generateOutput } : {}) });

  router.post('/projects/:projectId/requirements/extract', async (request, response, next) => {
    if (!isUuid(request.params.projectId)) return sendError(response, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    const inputId = request.body?.inputId;
    if (!isUuid(inputId)) return sendError(response, 400, 'inputId must be a UUID.', 'VALIDATION_ERROR');
    try {
      const result = await extractForInput(request.params.projectId, inputId);
      response.json({ data: result });
    } catch (error) {
      if (error instanceof RequirementExtractionError || error?.status >= 400 && error?.status < 600) {
        return sendError(response, error.status, error.message, error.code || 'REQUIREMENT_EXTRACTION_FAILED');
      }
      next(error);
    }
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
