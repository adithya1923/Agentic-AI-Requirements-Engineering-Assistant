import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();
const projectFields = `
  p.id, p.name, p.description, p.selected_domain, p.status,
  p.owner_id, u.display_name AS owner_name, p.created_at, p.updated_at`;
const projectJoins = 'FROM projects p LEFT JOIN users u ON u.id = p.owner_id';

function presentProject(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    selectedDomain: row.selected_domain,
    status: row.status,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/', async (_request, response, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${projectFields} ${projectJoins} ORDER BY p.updated_at DESC`);
    response.json({ data: rows.map(presentProject) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${projectFields} ${projectJoins} WHERE p.id = $1`,
      [request.params.id],
    );
    if (!rows.length) {
      return response.status(404).json({ error: { message: 'Project not found', code: 'PROJECT_NOT_FOUND' } });
    }
    response.json({ data: presentProject(rows[0]) });
  } catch (error) {
    if (error.code === '22P02') {
      return response.status(400).json({ error: { message: 'Project ID must be a UUID', code: 'VALIDATION_ERROR' } });
    }
    next(error);
  }
});

router.post('/', async (request, response, next) => {
  const { name, description = '', selectedDomain = 'Trade Finance / Letter of Credit', ownerId = null } = request.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return response.status(400).json({ error: { message: 'name is required', code: 'VALIDATION_ERROR' } });
  }
  if (name.trim().length > 160) {
    return response.status(400).json({ error: { message: 'name must be 160 characters or fewer', code: 'VALIDATION_ERROR' } });
  }
  if (typeof description !== 'string' || description.length > 4000) {
    return response.status(400).json({ error: { message: 'description must be 4000 characters or fewer', code: 'VALIDATION_ERROR' } });
  }
  if (typeof selectedDomain !== 'string' || !selectedDomain.trim() || selectedDomain.length > 120) {
    return response.status(400).json({ error: { message: 'selectedDomain must be a non-empty string of at most 120 characters', code: 'VALIDATION_ERROR' } });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO projects (name, description, selected_domain, owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [name.trim(), description.trim(), selectedDomain.trim(), ownerId],
    );
    const result = await pool.query(
      `SELECT ${projectFields} ${projectJoins} WHERE p.id = $1`,
      [rows[0].id],
    );
    response.status(201).json({ data: presentProject(result.rows[0]) });
  } catch (error) {
    if (error.code === '23503') {
      return response.status(400).json({ error: { message: 'ownerId must identify an existing user', code: 'INVALID_OWNER' } });
    }
    if (error.code === '22P02') {
      return response.status(400).json({ error: { message: 'ownerId must be a UUID', code: 'VALIDATION_ERROR' } });
    }
    next(error);
  }
});

export default router;
