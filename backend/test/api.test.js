import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { app } from '../src/app.js';
import { pool } from '../src/db/pool.js';

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('health endpoint reports the API is running', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'requirements-assistant-api',
  });
});

test('database health check reports a connected or unavailable database without exposing internals', async () => {
  const response = await fetch(`${baseUrl}/api/health/db`);
  const payload = await response.json();
  assert.ok([200, 503].includes(response.status));
  if (response.status === 200) {
    assert.deepEqual(payload, { status: 'ok', database: 'connected' });
  } else {
    assert.deepEqual(payload, {
      error: { message: 'Database is unavailable', code: 'DATABASE_UNAVAILABLE' },
    });
  }
});

test('project creation validates a missing project name', async () => {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'No project name' }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { message: 'name is required', code: 'VALIDATION_ERROR' },
  });
});

test('user creation validates unsupported roles', async () => {
  const response = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Reviewer', email: 'reviewer@example.test', role: 'SUPERUSER' }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { message: 'role is not supported', code: 'VALIDATION_ERROR' },
  });
});

test('unknown API routes return a structured not-found error', async () => {
  const response = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { message: 'Route not found', code: 'NOT_FOUND' },
  });
});
