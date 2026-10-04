import { Router } from 'express';
import { pool } from '../db/pool.js';
import { createSdlcAnalysis, presentSdlcAnalysis } from '../services/sdlc-agent.js';

const STATES = new Set(['REVIEWED', 'APPROVED', 'REJECTED', 'MODIFIED']);
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function createSdlcRouter({ database = pool, generateOutput } = {}) {
  const router = Router();
  router.post('/projects/:projectId/sdlc', async (req, res) => {
    if (!uuid(req.params.projectId)) return fail(res, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    try { return res.status(201).json({ data: await createSdlcAnalysis({ database, projectId: req.params.projectId, generateOutput }) }); }
    catch (error) { return fail(res, error.status || 503, error.status ? error.message : 'The SDLC analysis could not be completed.', error.code || 'SDLC_ANALYSIS_FAILED'); }
  });
  router.get('/projects/:projectId/sdlc', async (req, res) => {
    if (!uuid(req.params.projectId)) return fail(res, 400, 'Project ID must be a UUID.', 'VALIDATION_ERROR');
    try {
      const result = await database.query('SELECT * FROM sdlc_analyses WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [req.params.projectId]);
      if (!result.rowCount) return res.json({ data: null });
      return res.json({ data: presentSdlcAnalysis(result.rows[0]) });
    } catch { return fail(res, 503, 'Unable to load the project SDLC analysis.', 'DATABASE_ERROR'); }
  });
  router.patch('/requirements/:id/review', async (req, res) => {
    if (!uuid(req.params.id)) return fail(res, 400, 'Requirement ID must be a UUID.', 'VALIDATION_ERROR');
    const { status, note = '', requirementText } = req.body || {};
    if (!STATES.has(status) || typeof note !== 'string' || note.length > 1000 || (requirementText !== undefined && (typeof requirementText !== 'string' || !requirementText.trim() || requirementText.length > 3000)) || (status === 'MODIFIED' && requirementText === undefined)) return fail(res, 400, 'Provide a supported review status, a note up to 1000 characters, and revised requirementText when status is MODIFIED.', 'VALIDATION_ERROR');
    try {
      const result = await database.query(`UPDATE candidate_requirements SET review_status=$2,review_note=$3,reviewed_at=now(),requirement_text=CASE WHEN $2='MODIFIED' THEN $4 ELSE requirement_text END,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id, status, note.trim() || null, requirementText?.trim() || null]);
      if (!result.rowCount) return fail(res, 404, 'Requirement not found.', 'REQUIREMENT_NOT_FOUND');
      return res.json({ data: { id: result.rows[0].id, reviewStatus: result.rows[0].review_status, reviewNote: result.rows[0].review_note, reviewedAt: result.rows[0].reviewed_at, requirementText: result.rows[0].requirement_text, sourceEvidence: result.rows[0].source_evidence } });
    } catch { return fail(res, 503, 'Unable to save the requirement review state.', 'DATABASE_ERROR'); }
  });
  router.patch('/sdlc/:id/review', async (req, res) => {
    if (!uuid(req.params.id)) return fail(res, 400, 'SDLC analysis ID must be a UUID.', 'VALIDATION_ERROR');
    const { status, note = '' } = req.body || {};
    if (!STATES.has(status) || typeof note !== 'string' || note.length > 1000) return fail(res, 400, 'Provide a supported review status and a note up to 1000 characters.', 'VALIDATION_ERROR');
    try {
      const result = await database.query('UPDATE sdlc_analyses SET status=$2,review_note=$3,reviewed_at=now(),updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, status, note.trim() || null]);
      if (!result.rowCount) return fail(res, 404, 'SDLC analysis not found.', 'SDLC_NOT_FOUND');
      return res.json({ data: presentSdlcAnalysis(result.rows[0]) });
    } catch { return fail(res, 503, 'Unable to save the SDLC review state.', 'DATABASE_ERROR'); }
  });
  return router;
}

function fail(res, status, message, code) { return res.status(status).json({ error: { message, code } }); }
