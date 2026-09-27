import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDirectory, '../../database/schema.sql');

try {
  const schema = await fs.readFile(schemaPath, 'utf8');
  await pool.query(schema);
  console.log('Database schema initialized (safe to run more than once).');
} catch (error) {
  console.error(`Database initialization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
