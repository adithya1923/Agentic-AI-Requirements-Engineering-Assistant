import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { app, createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { chunkDocumentText } from '../src/services/knowledge-chunking.js';
import { generateEmbeddings, EmbeddingProviderError } from '../src/services/embeddings.js';

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('chunking is deterministic, ordered, bounded, and includes source character offsets', () => {
  const source = `${'Letters of credit use documentary evidence. '.repeat(45)}\nA later paragraph has separate provenance.`;
  const first = chunkDocumentText(source, { maxChars: 400, overlapChars: 50 });
  const second = chunkDocumentText(source, { maxChars: 400, overlapChars: 50 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 2);
  assert.deepEqual(first.map((chunk) => chunk.chunkIndex), first.map((_, index) => index));
  assert.ok(first.every((chunk) => chunk.chunkText.length <= 400 && chunk.metadata.charEnd > chunk.metadata.charStart
    && source.slice(chunk.metadata.charStart, chunk.metadata.charEnd) === chunk.chunkText));
  assert.equal(first[0].metadata.chunking, 'fixed-character-window-v1');
});

test('Ollama embedding adapter validates real provider response shape and fails closed', async () => {
  const valid = Array(config.knowledge.embeddingDimensions).fill(0);
  valid[0] = 1;
  let captured;
  const vectors = await generateEmbeddings(['document content'], {
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return Response.json({ embeddings: [valid] });
    },
  });
  assert.equal(captured.url, `${config.knowledge.ollamaBaseUrl}/api/embed`);
  assert.equal(captured.body.model, config.knowledge.embeddingModel);
  assert.equal(captured.body.truncate, false);
  assert.equal(vectors[0].length, 768);

  await assert.rejects(generateEmbeddings(['query'], {
    fetchImpl: async () => Response.json({ embeddings: [[0.2, Number.NaN]] }),
  }), EmbeddingProviderError);
  await assert.rejects(generateEmbeddings(['query'], {
    fetchImpl: async () => { throw new Error('service unavailable'); },
  }), /Embedding service is unavailable or timed out/);
});

test('knowledge endpoint validates metadata and rejects unsupported formats before database writes', async () => {
  const missingMetadata = await fetch(`${baseUrl}/knowledge/documents`, {
    method: 'POST', body: new FormData(),
  });
  assert.equal(missingMetadata.status, 400);
  assert.equal((await missingMetadata.json()).error.code, 'VALIDATION_ERROR');

  const invalidDomain = new FormData();
  invalidDomain.set('title', 'Invalid domain request');
  invalidDomain.set('source', 'Test fixture');
  invalidDomain.set('documentType', 'EDUCATIONAL_REFERENCE');
  invalidDomain.set('financialDomain', 'NOT_A_DOMAIN');
  const invalidDomainResponse = await fetch(`${baseUrl}/knowledge/documents`, { method: 'POST', body: invalidDomain });
  assert.equal(invalidDomainResponse.status, 400);
  assert.equal((await invalidDomainResponse.json()).error.code, 'VALIDATION_ERROR');

  const form = new FormData();
  form.set('title', 'Development PNG rejection');
  form.set('source', 'Test fixture');
  form.set('documentType', 'EDUCATIONAL_REFERENCE');
  form.set('financialDomain', 'PAYMENTS');
  form.set('file', new Blob(['not a real image'], { type: 'image/png' }), 'fixture.png');
  const response = await fetch(`${baseUrl}/knowledge/documents`, { method: 'POST', body: form });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'UNSUPPORTED_FILE_TYPE');
});

test('database-backed ingestion, chunks, embeddings, search and traceability', async (t) => {
  const available = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='vector') AS available");
  const installed = available.rows[0].available
    ? await pool.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed")
    : { rows: [{ installed: false }] };
  const table = await pool.query("SELECT to_regclass('public.knowledge_documents') IS NOT NULL AS exists");
  if (!available.rows[0].available || !installed.rows[0].installed || !table.rows[0].exists) {
    t.skip('requires the Phase 4 schema and pgvector extension');
    return;
  }

  const fixtureVector = (value) => {
    const vector = Array(768).fill(0);
    vector[value] = 1;
    return vector;
  };
  let failEmbedding = false;
  const testApp = createApp({
    embedDocuments: async (chunks) => {
      if (failEmbedding) throw new EmbeddingProviderError('Test-only unavailable embedding provider.');
      return chunks.map(({ chunkText }) => fixtureVector(/loan|credit/i.test(chunkText) ? 1 : 0));
    },
    embedQuery: async (query) => fixtureVector(/loan|credit/i.test(query) ? 1 : 0),
  });
  const testServer = testApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => testServer.once('listening', resolve));
  const testBase = `http://127.0.0.1:${testServer.address().port}/api/knowledge`;
  const documentIds = [];
  const storedFiles = [];
  try {
    const documents = [
      { title: 'Development payments reference', source: 'DEVELOPMENT / DEMONSTRATION DATA', financialDomain: 'PAYMENTS', text: 'Payment processing moves a funds transfer between accounts.' },
      { title: 'Development loans reference', source: 'DEVELOPMENT / DEMONSTRATION DATA', financialDomain: 'LOANS_CREDIT', text: 'Loan credit assessment reviews repayment capacity.' },
    ];
    for (const item of documents) {
      const form = new FormData();
      form.set('title', item.title); form.set('source', item.source); form.set('documentType', 'EDUCATIONAL_REFERENCE');
      form.set('financialDomain', item.financialDomain);
      form.set('jurisdiction', 'DEVELOPMENT'); form.set('version', 'fixture-1');
      form.set('file', new Blob([item.text], { type: 'text/plain' }), `${item.title.replaceAll(' ', '-')}.txt`);
      const response = await fetch(`${testBase}/documents`, { method: 'POST', body: form });
      assert.equal(response.status, 201, await response.clone().text());
      const created = (await response.json()).data;
      documentIds.push(created.id);
      storedFiles.push(path.join(config.knowledge.uploadDirectory, `${created.id}.txt`));
      assert.equal(created.processingStatus, 'READY');
      assert.equal(created.financialDomain, item.financialDomain);
      assert.ok(created.chunkCount >= 1);
    }

    const search = await fetch(`${testBase}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        query: 'loan credit assessment', topK: 5,
        filters: { financialDomain: 'LOANS_CREDIT', documentType: 'EDUCATIONAL_REFERENCE', jurisdiction: 'DEVELOPMENT' },
      }),
    });
    assert.equal(search.status, 200);
    const results = (await search.json()).data;
    assert.ok(results.length >= 1);
    assert.ok(results.every((item) => item.document.financialDomain === 'LOANS_CREDIT'));
    assert.ok(results.every((item) => item.document.documentType === 'EDUCATIONAL_REFERENCE' && item.document.jurisdiction === 'DEVELOPMENT'));
    const result = results[0];
    assert.ok(result.chunkId);
    assert.equal(result.document.title, 'Development loans reference');
    assert.equal(result.document.source, 'DEVELOPMENT / DEMONSTRATION DATA');
    assert.equal(result.document.financialDomain, 'LOANS_CREDIT');
    assert.equal(result.knowledgeDocumentId, documentIds[1]);
    assert.match(result.chunkText, /loan credit/i);

    const paymentSearch = await fetch(`${testBase}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        query: 'payment transfer', topK: 5, filters: { financialDomain: 'PAYMENTS' },
      }),
    });
    assert.equal(paymentSearch.status, 200);
    const paymentResults = (await paymentSearch.json()).data;
    assert.ok(paymentResults.length >= 1);
    assert.ok(paymentResults.every((item) => item.document.financialDomain === 'PAYMENTS'));
    assert.ok(paymentResults.every((item) => item.knowledgeDocumentId !== documentIds[1]));

    const invalidDomainSearch = await fetch(`${testBase}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        query: 'payment', filters: { financialDomain: 'NOT_A_DOMAIN' },
      }),
    });
    assert.equal(invalidDomainSearch.status, 400);

    const detailResponse = await fetch(`${testBase}/documents/${result.knowledgeDocumentId}/chunks`);
    const detail = (await detailResponse.json()).data;
    assert.equal(detail.document.id, result.knowledgeDocumentId);
    assert.equal(detail.document.financialDomain, 'LOANS_CREDIT');
    assert.ok(detail.chunks.some((chunk) => chunk.id === result.chunkId));
    const list = await fetch(`${testBase}/documents`);
    const listed = (await list.json()).data.filter(({ id }) => documentIds.includes(id));
    assert.equal(listed.length, 2);
    assert.deepEqual(new Set(listed.map(({ financialDomain }) => financialDomain)), new Set(['PAYMENTS', 'LOANS_CREDIT']));

    failEmbedding = true;
    const failedForm = new FormData();
    failedForm.set('title', 'Development embedding failure fixture');
    failedForm.set('source', 'DEVELOPMENT / DEMONSTRATION DATA');
    failedForm.set('documentType', 'EDUCATIONAL_REFERENCE');
    failedForm.set('financialDomain', 'GENERAL_FINANCIAL');
    failedForm.set('file', new Blob(['This fixture records a test embedding failure.'], { type: 'text/plain' }), 'failure.txt');
    const failedResponse = await fetch(`${testBase}/documents`, { method: 'POST', body: failedForm });
    assert.equal(failedResponse.status, 503);
    const failedRecord = (await failedResponse.json()).data;
    documentIds.push(failedRecord.id);
    storedFiles.push(path.join(config.knowledge.uploadDirectory, `${failedRecord.id}.txt`));
    assert.equal(failedRecord.processingStatus, 'FAILED');
    const failedDetail = await fetch(`${testBase}/documents/${failedRecord.id}`);
    assert.equal((await failedDetail.json()).data.processingStatus, 'FAILED');
  } finally {
    await new Promise((resolve) => testServer.close(resolve));
    for (const storedFile of storedFiles) await fs.rm(storedFile, { force: true });
    if (documentIds.length) await pool.query('DELETE FROM knowledge_documents WHERE id=ANY($1::uuid[])', [documentIds]);
  }
});
