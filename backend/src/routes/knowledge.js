import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { DocumentExtractionError, extractDocumentText } from '../services/document-extraction.js';
import { chunkDocumentText } from '../services/knowledge-chunking.js';
import { embedDocumentChunks, embedSearchQuery, EmbeddingProviderError } from '../services/embeddings.js';

const documentTypes = new Set([
  'REGULATORY_MATERIAL', 'ORGANIZATIONAL_POLICY', 'BUSINESS_DOMAIN_REFERENCE',
  'RISK_CONTROL_REFERENCE', 'LEGACY_SYSTEM_DOCUMENTATION', 'EDUCATIONAL_REFERENCE', 'OTHER',
]);
const financialDomains = new Set([
  'GENERAL_FINANCIAL', 'DIGITAL_BANKING', 'LOANS_CREDIT', 'PAYMENTS', 'FRAUD_DETECTION',
  'INSURANCE', 'INVESTMENT', 'REGULATORY_REPORTING', 'CUSTOMER_ONBOARDING_KYC',
  'FINANCIAL_DATA_ANALYTICS', 'TRADE_FINANCE', 'OTHER_FINANCIAL',
]);
const mimes = new Map([
  ['.pdf', new Set(['application/pdf', 'application/octet-stream'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'])],
  ['.txt', new Set(['text/plain', 'application/octet-stream'])],
]);
const fields = `id, title, source, document_type, financial_domain, jurisdiction, version, effective_date, authority, tags,
  original_filename, mime_type, file_size_bytes, processing_status, processing_error, created_at, updated_at`;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 12, parts: 14 } });

function respondError(response, status, message, code, data) {
  return response.status(status).json({ error: { message, code }, ...(data ? { data } : {}) });
}

function presentDocument(row) {
  return {
    id: row.id, title: row.title, source: row.source, documentType: row.document_type, financialDomain: row.financial_domain,
    jurisdiction: row.jurisdiction, version: row.version,
    effectiveDate: row.effective_date, authority: row.authority, tags: row.tags,
    originalFilename: row.original_filename, mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes, processingStatus: row.processing_status,
    processingError: row.processing_error, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.extracted_text !== undefined ? { extractedText: row.extracted_text } : {}),
  };
}

function cleanFilename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) return null;
  const name = value.replaceAll('\\', '/').split('/').at(-1).trim();
  if (!name || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name.length <= 255 ? name : name.slice(-255);
}

function parseTags(value) {
  if (value === undefined || value === '') return [];
  let tags;
  try { tags = Array.isArray(value) ? value : JSON.parse(value); } catch { tags = String(value).split(','); }
  if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 80)) {
    return null;
  }
  return [...new Set(tags.map((tag) => tag.trim()))];
}

function validateMetadata(body = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const documentType = typeof body.documentType === 'string' ? body.documentType.trim().toUpperCase() : '';
  const financialDomain = typeof body.financialDomain === 'string' ? body.financialDomain.trim().toUpperCase() : '';
  const jurisdiction = typeof body.jurisdiction === 'string' ? body.jurisdiction.trim() : null;
  const version = typeof body.version === 'string' ? body.version.trim() : null;
  const authority = typeof body.authority === 'string' ? body.authority.trim() : null;
  const effectiveDate = body.effectiveDate ? String(body.effectiveDate).trim() : null;
  const tags = parseTags(body.tags);
  if (!title || title.length > 200) return { error: 'title is required and must be 200 characters or fewer' };
  if (!source || source.length > 200) return { error: 'source is required and must be 200 characters or fewer' };
  if (!documentTypes.has(documentType)) return { error: 'documentType is not supported' };
  if (!financialDomains.has(financialDomain)) return { error: 'financialDomain is required and must be a supported financial domain' };
  if ((jurisdiction && jurisdiction.length > 120) || (version && version.length > 120) || (authority && authority.length > 200)) {
    return { error: 'jurisdiction and version must be 120 characters or fewer; authority must be 200 characters or fewer' };
  }
  if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return { error: 'effectiveDate must use YYYY-MM-DD format' };
  if (tags === null) return { error: 'tags must be up to 30 non-empty strings of at most 80 characters' };
  return { title, source, documentType, financialDomain, jurisdiction: jurisdiction || null, version: version || null,
    effectiveDate, authority: authority || null, tags };
}

function uploadOne(request, response, next) {
  upload.single('file')(request, response, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return respondError(response, 413, `File exceeds the ${config.maxUploadBytes}-byte size limit`, 'FILE_TOO_LARGE');
    if (error.code?.startsWith('LIMIT_')) return respondError(response, 400, 'Upload contains unsupported or excessive multipart fields', 'INVALID_UPLOAD');
    next(error);
  });
}

function safeDate(metadata) {
  if (!metadata.effectiveDate) return true;
  const date = new Date(`${metadata.effectiveDate}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(metadata.effectiveDate);
}

export function createKnowledgeRouter({ embedDocuments = embedDocumentChunks, embedQuery = embedSearchQuery } = {}) {
  const router = Router();

  router.post('/documents', uploadOne, async (request, response, next) => {
    const metadata = validateMetadata(request.body);
    if (metadata.error) return respondError(response, 400, metadata.error, 'VALIDATION_ERROR');
    if (!safeDate(metadata)) return respondError(response, 400, 'effectiveDate is not a calendar date', 'VALIDATION_ERROR');
    if (!request.file) return respondError(response, 400, 'A document file is required', 'FILE_REQUIRED');
    const originalFilename = cleanFilename(request.file.originalname);
    if (!originalFilename) return respondError(response, 400, 'The original filename is invalid', 'INVALID_FILENAME');
    const extension = path.extname(originalFilename).toLowerCase();
    const acceptedMimes = mimes.get(extension);
    if (!acceptedMimes) return respondError(response, 415, 'Supported document formats are PDF, DOCX, and TXT', 'UNSUPPORTED_FILE_TYPE');
    if (!acceptedMimes.has(String(request.file.mimetype).toLowerCase())) {
      return respondError(response, 415, 'File type does not match its filename extension', 'FILE_TYPE_MISMATCH');
    }

    const id = randomUUID();
    const storageKey = `${id}${extension}`;
    const storagePath = path.join(config.knowledge.uploadDirectory, storageKey);
    const expectedMime = extension === '.pdf' ? 'application/pdf'
      : extension === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain';
    let row;
    try {
      const inserted = await pool.query(
        `INSERT INTO knowledge_documents
          (id, title, source, document_type, financial_domain, jurisdiction, version, effective_date, authority, tags,
           original_filename, mime_type, file_size_bytes, storage_key, processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'RECEIVED') RETURNING ${fields}`,
        [id, metadata.title, metadata.source, metadata.documentType, metadata.financialDomain,
          metadata.jurisdiction, metadata.version, metadata.effectiveDate, metadata.authority, metadata.tags,
          originalFilename, expectedMime,
          request.file.size, storageKey],
      );
      row = inserted.rows[0];
    } catch (error) { return next(error); }

    try {
      await fs.mkdir(config.knowledge.uploadDirectory, { recursive: true });
      await fs.writeFile(storagePath, request.file.buffer, { flag: 'wx', mode: 0o600 });
      await pool.query("UPDATE knowledge_documents SET processing_status='PROCESSING', updated_at=now() WHERE id=$1", [id]);
      const extractedText = await extractDocumentText(request.file.buffer, extension);
      const chunks = chunkDocumentText(extractedText);
      if (!chunks.length) throw new DocumentExtractionError('No text could be divided into knowledge chunks.');
      const embeddings = [];
      for (let offset = 0; offset < chunks.length; offset += 16) {
        const batch = await embedDocuments(chunks.slice(offset, offset + 16), metadata.title);
        if (batch.length !== Math.min(16, chunks.length - offset)) {
          throw new EmbeddingProviderError('Embedding provider returned the wrong number of vectors.');
        }
        embeddings.push(...batch);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let index = 0; index < chunks.length; index += 1) {
          const vectorLiteral = `[${embeddings[index].join(',')}]`;
          await client.query(
            `INSERT INTO knowledge_chunks
              (knowledge_document_id, chunk_index, chunk_text, chunk_metadata, embedding, embedding_model)
             VALUES ($1,$2,$3,$4,$5::vector,$6)`,
            [id, chunks[index].chunkIndex, chunks[index].chunkText, chunks[index].metadata,
              vectorLiteral, config.knowledge.embeddingModel],
          );
        }
        const ready = await client.query(
          `UPDATE knowledge_documents SET extracted_text=$2, processing_status='READY', processing_error=NULL, updated_at=now()
           WHERE id=$1 RETURNING ${fields}`,
          [id, extractedText],
        );
        await client.query('COMMIT');
        return response.status(201).json({ data: { ...presentDocument(ready.rows[0]), chunkCount: chunks.length } });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } catch (error) {
      const extractionFailure = error instanceof DocumentExtractionError;
      const embeddingFailure = error instanceof EmbeddingProviderError;
      const publicMessage = extractionFailure || embeddingFailure ? error.message : 'Unable to store or process the knowledge document.';
      try {
        const failed = await pool.query(
          `UPDATE knowledge_documents SET processing_status='FAILED', processing_error=$2, updated_at=now()
           WHERE id=$1 RETURNING ${fields}`,
          [id, publicMessage],
        );
        row = failed.rows[0] || row;
      } catch (updateError) { return next(updateError); }
      const status = extractionFailure ? 422 : embeddingFailure ? 503 : 500;
      const code = extractionFailure ? 'EXTRACTION_FAILED' : embeddingFailure ? error.code : 'KNOWLEDGE_PROCESSING_FAILED';
      return respondError(response, status, publicMessage, code, presentDocument(row));
    }
  });

  router.get('/documents', async (_request, response, next) => {
    try {
      const result = await pool.query(`SELECT ${fields}, (SELECT count(*)::int FROM knowledge_chunks c WHERE c.knowledge_document_id=d.id) AS chunk_count
        FROM knowledge_documents d ORDER BY d.created_at DESC`);
      response.json({ data: result.rows.map((row) => ({ ...presentDocument(row), chunkCount: row.chunk_count })) });
    } catch (error) { next(error); }
  });

  router.get('/documents/:id/chunks', async (request, response, next) => {
    if (!isUuid(request.params.id)) return respondError(response, 400, 'Document ID must be a UUID', 'VALIDATION_ERROR');
    try {
      const document = await pool.query(`SELECT ${fields} FROM knowledge_documents WHERE id=$1`, [request.params.id]);
      if (!document.rows.length) return respondError(response, 404, 'Knowledge document not found', 'DOCUMENT_NOT_FOUND');
      const chunks = await pool.query(`SELECT id, knowledge_document_id, chunk_index, chunk_text, chunk_metadata, embedding_model, created_at
        FROM knowledge_chunks WHERE knowledge_document_id=$1 ORDER BY chunk_index`, [request.params.id]);
      response.json({ data: { document: presentDocument(document.rows[0]), chunks: chunks.rows.map(presentChunk) } });
    } catch (error) { next(error); }
  });

  router.get('/documents/:id', async (request, response, next) => {
    if (!isUuid(request.params.id)) return respondError(response, 400, 'Document ID must be a UUID', 'VALIDATION_ERROR');
    try {
      const result = await pool.query(`SELECT ${fields} FROM knowledge_documents WHERE id=$1`, [request.params.id]);
      if (!result.rows.length) return respondError(response, 404, 'Knowledge document not found', 'DOCUMENT_NOT_FOUND');
      const count = await pool.query('SELECT count(*)::int AS count FROM knowledge_chunks WHERE knowledge_document_id=$1', [request.params.id]);
      response.json({ data: { ...presentDocument(result.rows[0]), chunkCount: count.rows[0].count } });
    } catch (error) { next(error); }
  });

  router.post('/search', async (request, response, next) => {
    const query = typeof request.body?.query === 'string' ? request.body.query.trim() : '';
    const topKValue = request.body?.topK ?? request.body?.limit ?? 5;
    const topK = Number(topKValue);
    const filters = request.body?.filters ?? {};
    if (!query || query.length > config.maxInputChars) return respondError(response, 400, `query is required and must be ${config.maxInputChars} characters or fewer`, 'VALIDATION_ERROR');
    if (!Number.isInteger(topK) || topK < 1 || topK > config.knowledge.maxSearchTopK) {
      return respondError(response, 400, `topK must be an integer between 1 and ${config.knowledge.maxSearchTopK}`, 'VALIDATION_ERROR');
    }
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      return respondError(response, 400, 'filters must be an object', 'VALIDATION_ERROR');
    }
    if (filters.jurisdiction !== undefined && typeof filters.jurisdiction !== 'string') {
      return respondError(response, 400, 'filters.jurisdiction must be a string', 'VALIDATION_ERROR');
    }
    if (filters.financialDomain !== undefined && typeof filters.financialDomain !== 'string') {
      return respondError(response, 400, 'filters.financialDomain must be a string', 'VALIDATION_ERROR');
    }
    const documentType = filters.documentType === undefined ? null : String(filters.documentType).toUpperCase();
    const jurisdiction = filters.jurisdiction === undefined ? null : String(filters.jurisdiction).trim();
    const financialDomain = filters.financialDomain === undefined ? null : String(filters.financialDomain).trim().toUpperCase();
    if (documentType && !documentTypes.has(documentType)) return respondError(response, 400, 'filters.documentType is not supported', 'VALIDATION_ERROR');
    if (jurisdiction && jurisdiction.length > 120) return respondError(response, 400, 'filters.jurisdiction must be 120 characters or fewer', 'VALIDATION_ERROR');
    if (financialDomain && !financialDomains.has(financialDomain)) return respondError(response, 400, 'filters.financialDomain is not supported', 'VALIDATION_ERROR');
    try {
      const vector = await embedQuery(query);
      const result = await pool.query(
        `SELECT c.id AS chunk_id, d.id AS knowledge_document_id, d.title, d.source,
          d.document_type, d.financial_domain, d.jurisdiction, d.version, d.effective_date, d.authority, d.tags,
          c.chunk_index, c.chunk_text, c.chunk_metadata, 1 - (c.embedding <=> $1::vector) AS similarity
         FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.knowledge_document_id
         WHERE d.processing_status='READY' AND d.financial_domain IS NOT NULL
           AND ($2::text IS NULL OR d.document_type=$2)
           AND ($3::text IS NULL OR d.jurisdiction=$3)
           AND ($4::text IS NULL OR d.financial_domain=$4)
         ORDER BY c.embedding <=> $1::vector LIMIT $5`,
        [`[${vector.join(',')}]`, documentType, jurisdiction || null, financialDomain, topK],
      );
      response.json({ data: result.rows.map(presentSearchResult), query, topK: result.rows.length });
    } catch (error) {
      if (error instanceof EmbeddingProviderError) return respondError(response, 503, error.message, error.code);
      next(error);
    }
  });

  return router;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function presentChunk(row) {
  return { id: row.id, knowledgeDocumentId: row.knowledge_document_id, chunkIndex: row.chunk_index,
    chunkText: row.chunk_text, metadata: row.chunk_metadata, embeddingModel: row.embedding_model, createdAt: row.created_at };
}

function presentSearchResult(row) {
  return { chunkId: row.chunk_id, knowledgeDocumentId: row.knowledge_document_id,
    document: { title: row.title, source: row.source, documentType: row.document_type, financialDomain: row.financial_domain,
      jurisdiction: row.jurisdiction, version: row.version, effectiveDate: row.effective_date,
      authority: row.authority, tags: row.tags },
    chunkIndex: row.chunk_index, chunkText: row.chunk_text, chunkMetadata: row.chunk_metadata,
    similarity: Number(row.similarity) };
}

