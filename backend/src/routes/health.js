import { Router } from 'express';
import { pool } from '../db/pool.js';

const router = Router();

router.get('/', (_request, response) => {
  response.json({ status: 'ok', service: 'requirements-assistant-api' });
});

router.get('/db', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    error.status = 503;
    error.code = 'DATABASE_UNAVAILABLE';
    error.message = 'Database is unavailable';
    next(error);
  }
});

export default router;
