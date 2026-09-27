import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
export const pool = new Pool(config.database);

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});
