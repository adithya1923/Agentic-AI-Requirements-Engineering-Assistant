import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();
const roles = new Set([
  'ADMIN', 'BUSINESS_STAKEHOLDER', 'REQUIREMENTS_ENGINEER', 'TECHNICAL_STAKEHOLDER',
  'COMPLIANCE', 'SECURITY', 'RISK', 'PROJECT_MANAGER', 'APPROVER',
]);

router.get('/', async (_request, response, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, display_name, email, role, created_at FROM users ORDER BY display_name, created_at',
    );
    response.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (request, response, next) => {
  const { displayName, email, role = 'BUSINESS_STAKEHOLDER' } = request.body || {};
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return response.status(400).json({ error: { message: 'displayName is required', code: 'VALIDATION_ERROR' } });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return response.status(400).json({ error: { message: 'A valid email is required', code: 'VALIDATION_ERROR' } });
  }
  const normalizedRole = String(role).toUpperCase();
  if (!roles.has(normalizedRole)) {
    return response.status(400).json({ error: { message: 'role is not supported', code: 'VALIDATION_ERROR' } });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (display_name, email, role)
       VALUES ($1, $2, $3)
       RETURNING id, display_name, email, role, created_at`,
      [displayName.trim(), email.trim().toLowerCase(), normalizedRole],
    );
    response.status(201).json({ data: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return response.status(409).json({ error: { message: 'A user with that email already exists', code: 'USER_EXISTS' } });
    }
    next(error);
  }
});

export default router;
