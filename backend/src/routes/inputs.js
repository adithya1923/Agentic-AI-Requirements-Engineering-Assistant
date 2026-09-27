import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { DocumentExtractionError, extractDocumentText } from '../services/document-extraction.js';

const router = Router();
const textInputTypes = new Set([
  'STAKEHOLDER_STATEMENT', 'MEETING_NOTES', 'INTERVIEW_TRANSCRIPT',
  'REQUIREMENT_NOTES', 'BUSINESS_CONTEXT', 'PROCESS_DESCRIPTION', 'OTHER_TEXT',
]);
const supportedFormats = new Map([
  ['.pdf', new Set(['application/pdf', 'application/octet-stream'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'])],
  ['.txt', new Set(['text/plain', 'application/octet-stream'])],
]);
const columns = `id, project_id, input_type, title, source, original_filename, mime_type,
  file_size_bytes, processing_status, processing_error, created_by, created_at, updated_at`;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, parts: 12 },
});

function publicInput(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    inputType: row.input_type,
    title: row.title,
    source: row.source,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    processingStatus: row.processing_status,
    processingError: row.processing_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sendError(response, status, message, code) {
  return response.status(status).json({ error: { message, code } });
}

function validUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateProjectId(request, response, next) {
  if (!validUuid(request.params.projectId)) {
    return sendError(response, 400, 'Project ID must be a UUID', 'VALIDATION_ERROR');
  }
  next();
}

async function projectExists(projectId) {
  const result = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  return result.rowCount > 0;
}

function validateTextMetadata(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const source = typeof body.source === 'string' ? body.source.trim() : '';
  const inputType = typeof body.inputType === 'string' ? body.inputType.trim().toUpperCase() : '';
  const content = typeof body.content === 'string' ? body.content : '';

  if (!title) return { error: 'title is required' };
  if (title.length > 200) return { error: 'title must be 200 characters or fewer' };
  if (!source) return { error: 'source is required' };
  if (source.length > 200) return { error: 'source must be 200 characters or fewer' };
  if (!textInputTypes.has(inputType)) return { error: 'inputType must be a supported text input type' };
  if (!content.trim()) return { error: 'content is required' };
  if (content.length > config.maxInputChars) return { error: `content must be ${config.maxInputChars} characters or fewer` };

  let createdBy = null;
  if (body.createdBy !== undefined && body.createdBy !== null && body.createdBy !== '') {
    if (!validUuid(body.createdBy)) return { error: 'createdBy must be a UUID' };
    createdBy = body.createdBy;
  }
  return { title, source, inputType, content, createdBy };
}

function cleanOriginalFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 1024) return null;
  const basename = filename.replaceAll('\\', '/').split('/').at(-1).trim();
  if (!basename || basename === '.' || basename === '..' || /[\u0000-\u001f\u007f]/.test(basename)) return null;
  return basename.length <= 255 ? basename : basename.slice(-255);
}

function validateUploadedFile(file) {
  if (!file) return { error: 'A document file is required', status: 400, code: 'FILE_REQUIRED' };
  const filename = cleanOriginalFilename(file.originalname);
  if (!filename) return { error: 'The original filename is invalid', status: 400, code: 'INVALID_FILENAME' };
  const extension = path.extname(filename).toLowerCase();
  const allowedMimeTypes = supportedFormats.get(extension);
  if (!allowedMimeTypes) {
    return { error: 'Supported document formats are PDF, DOCX, and TXT', status: 415, code: 'UNSUPPORTED_FILE_TYPE' };
  }
  if (!allowedMimeTypes.has(String(file.mimetype).toLowerCase())) {
    return { error: 'File type does not match its filename extension', status: 415, code: 'FILE_TYPE_MISMATCH' };
  }
  return { filename, extension };
}

function uploadOne(request, response, next) {
  upload.single('file')(request, response, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return sendError(response, 413, `File exceeds the ${config.maxUploadBytes}-byte size limit`, 'FILE_TOO_LARGE');
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_PART_COUNT' || error.code === 'LIMIT_FIELD_COUNT') {
      return sendError(response, 400, 'Upload contains unsupported or excessive multipart fields', 'INVALID_UPLOAD');
    }
    next(error);
  });
}

router.post('/projects/:projectId/inputs', validateProjectId, async (request, response, next) => {
  const values = validateTextMetadata(request.body || {});
  if (values.error) return sendError(response, 400, values.error, 'VALIDATION_ERROR');

  try {
    if (!(await projectExists(request.params.projectId))) {
      return sendError(response, 404, 'Project not found', 'PROJECT_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `INSERT INTO project_inputs
        (project_id, input_type, title, source, submitted_content, extracted_text, processing_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $5, 'READY', $6)
       RETURNING ${columns}`,
      [request.params.projectId, values.inputType, values.title, values.source, values.content, values.createdBy],
    );
    response.status(201).json({ data: publicInput(rows[0]) });
  } catch (error) {
    if (error.code === '23503') return sendError(response, 400, 'createdBy must identify an existing user', 'INVALID_CREATOR');
    next(error);
  }
});

router.get('/projects/:projectId/inputs', validateProjectId, async (request, response, next) => {
  try {
    if (!(await projectExists(request.params.projectId))) {
      return sendError(response, 404, 'Project not found', 'PROJECT_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `SELECT ${columns} FROM project_inputs WHERE project_id = $1 ORDER BY created_at DESC`,
      [request.params.projectId],
    );
    response.json({ data: rows.map(publicInput) });
  } catch (error) {
    next(error);
  }
});

router.post('/projects/:projectId/inputs/documents', validateProjectId, async (request, response, next) => {
  try {
    if (!(await projectExists(request.params.projectId))) {
      return sendError(response, 404, 'Project not found', 'PROJECT_NOT_FOUND');
    }
    next();
  } catch (error) {
    next(error);
  }
}, uploadOne, async (request, response, next) => {
  const metadata = validateTextMetadata({
    title: request.body.title,
    source: request.body.source,
    inputType: 'OTHER_TEXT',
    content: 'document upload metadata',
    createdBy: request.body.createdBy,
  });
  if (metadata.error) return sendError(response, 400, metadata.error, 'VALIDATION_ERROR');

  const fileMetadata = validateUploadedFile(request.file);
  if (fileMetadata.error) return sendError(response, fileMetadata.status, fileMetadata.error, fileMetadata.code);

  const { file } = request;
  const { filename, extension } = fileMetadata;
  const expectedMimeType = extension === '.pdf'
    ? 'application/pdf'
    : extension === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'text/plain';
  const inputId = randomUUID();
  const storageKey = `${inputId}${extension}`;
  const storagePath = path.join(config.uploadDirectory, storageKey);
  let row;

  try {
    const inserted = await pool.query(
      `INSERT INTO project_inputs
        (id, project_id, input_type, title, source, original_filename, mime_type,
         file_size_bytes, storage_key, processing_status, created_by)
       VALUES ($1, $2, 'DOCUMENT', $3, $4, $5, $6, $7, $8, 'RECEIVED', $9)
       RETURNING ${columns}`,
      [inputId, request.params.projectId, metadata.title, metadata.source, filename,
        expectedMimeType, file.size, storageKey, metadata.createdBy],
    );
    row = inserted.rows[0];
  } catch (error) {
    if (error.code === '23503') return sendError(response, 400, 'createdBy must identify an existing user', 'INVALID_CREATOR');
    return next(error);
  }

  try {
    await fs.mkdir(config.uploadDirectory, { recursive: true });
    await fs.writeFile(storagePath, file.buffer, { flag: 'wx', mode: 0o600 });
    await pool.query(
      "UPDATE project_inputs SET processing_status = 'PROCESSING', updated_at = now() WHERE id = $1",
      [inputId],
    );
    const extractedText = await extractDocumentText(file.buffer, extension);
    const ready = await pool.query(
      `UPDATE project_inputs
       SET extracted_text = $2, processing_status = 'READY', processing_error = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${columns}`,
      [inputId, extractedText],
    );
    return response.status(201).json({ data: publicInput(ready.rows[0]) });
  } catch (error) {
    const extractionFailed = error instanceof DocumentExtractionError;
    const safeMessage = extractionFailed ? error.message : 'Unable to store or process the uploaded document.';
    try {
      const failed = await pool.query(
        `UPDATE project_inputs
         SET processing_status = 'FAILED', processing_error = $2, updated_at = now()
         WHERE id = $1 RETURNING ${columns}`,
        [inputId, safeMessage],
      );
      row = failed.rows[0] || row;
    } catch (updateError) {
      return next(updateError);
    }
    if (!extractionFailed) {
      return response.status(500).json({
        error: { message: safeMessage, code: 'DOCUMENT_PROCESSING_FAILED' },
        data: publicInput(row),
      });
    }
    return response.status(422).json({
      error: { message: safeMessage, code: 'EXTRACTION_FAILED' },
      data: publicInput(row),
    });
  }
});

router.get('/inputs/:id', async (request, response, next) => {
  if (!validUuid(request.params.id)) {
    return sendError(response, 400, 'Input ID must be a UUID', 'VALIDATION_ERROR');
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM project_inputs WHERE id = $1`,
      [request.params.id],
    );
    if (!rows.length) return sendError(response, 404, 'Input not found', 'INPUT_NOT_FOUND');
    response.json({ data: publicInput(rows[0]) });
  } catch (error) {
    next(error);
  }
});

router.get('/inputs/:id/content', async (request, response, next) => {
  if (!validUuid(request.params.id)) {
    return sendError(response, 400, 'Input ID must be a UUID', 'VALIDATION_ERROR');
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, input_type, processing_status, submitted_content, extracted_text
       FROM project_inputs WHERE id = $1`,
      [request.params.id],
    );
    if (!rows.length) return sendError(response, 404, 'Input not found', 'INPUT_NOT_FOUND');
    const input = rows[0];
    if (input.processing_status !== 'READY') {
      return sendError(response, 409, 'Input content is not ready to retrieve', 'INPUT_NOT_READY');
    }
    response.json({
      data: {
        id: input.id,
        inputType: input.input_type,
        contentKind: input.input_type === 'DOCUMENT' ? 'EXTRACTED' : 'SUBMITTED',
        content: input.input_type === 'DOCUMENT' ? input.extracted_text : input.submitted_content,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
