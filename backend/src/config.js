import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(backendDirectory, '../..');
dotenv.config({ path: path.resolve(backendDirectory, '../../.env') });

export const config = {
  port: Number(process.env.API_PORT || 4000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173',
  uploadDirectory: path.resolve(projectRoot, process.env.UPLOAD_STORAGE_DIR || 'storage/uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  maxInputChars: Number(process.env.MAX_INPUT_CHARS || 100_000),
  maxExtractedChars: Number(process.env.MAX_EXTRACTED_CHARS || 1_000_000),
  maxPdfPages: Number(process.env.MAX_PDF_PAGES || 200),
  knowledge: {
    uploadDirectory: path.resolve(projectRoot, process.env.KB_UPLOAD_STORAGE_DIR || 'storage/knowledge'),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
    embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma',
    embeddingDimensions: 768,
    documentEmbeddingPrefix: process.env.KB_DOCUMENT_EMBEDDING_PREFIX ?? 'title: {title} | text: {text}',
    queryEmbeddingPrefix: process.env.KB_QUERY_EMBEDDING_PREFIX ?? 'task: search result | query: {query}',
    ollamaTimeoutMillis: Number(process.env.OLLAMA_TIMEOUT_MS || 120_000),
    maxChunkChars: Number(process.env.KB_MAX_CHUNK_CHARS || 1200),
    chunkOverlapChars: Number(process.env.KB_CHUNK_OVERLAP_CHARS || 150),
    maxSearchTopK: Number(process.env.KB_MAX_SEARCH_TOP_K || 20),
  },
  generation: {
    ollamaBaseUrl: (process.env.OLLAMA_GENERATION_BASE_URL || 'http://localhost:11434').replace(/\/$/, ''),
    model: process.env.OLLAMA_GENERATION_MODEL || 'qwen2.5:3b',
    timeoutMillis: Number(process.env.OLLAMA_GENERATION_TIMEOUT_MS || 120_000),
  },
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME || process.env.POSTGRES_DB || 'requirements_assistant',
    user: process.env.DATABASE_USER || process.env.POSTGRES_USER || 'app_user',
    password: process.env.DATABASE_PASSWORD || process.env.POSTGRES_PASSWORD || '',
    connectionTimeoutMillis: 3000,
  },
};
