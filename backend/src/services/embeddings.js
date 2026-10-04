import { config } from '../config.js';
import { maskSensitiveText } from './sensitive-data.js';

export class EmbeddingProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbeddingProviderError';
    this.code = 'EMBEDDING_PROVIDER_FAILED';
  }
}

export async function generateEmbeddings(texts, { fetchImpl = fetch, model = config.knowledge.embeddingModel, truncate = false } = {}) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.some((text) => typeof text !== 'string' || !text.trim())) {
    throw new EmbeddingProviderError('Embedding input must contain non-empty text.');
  }

  let response;
  try {
    response = await fetchImpl(`${config.knowledge.ollamaBaseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, truncate }),
      signal: AbortSignal.timeout(config.knowledge.ollamaTimeoutMillis),
    });
  } catch {
    throw new EmbeddingProviderError('Embedding service is unavailable or timed out.');
  }
  if (!response.ok) throw new EmbeddingProviderError(`Embedding service returned HTTP ${response.status}.`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new EmbeddingProviderError('Embedding service returned invalid JSON.');
  }
  const vectors = payload.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new EmbeddingProviderError('Embedding service returned an unexpected number of vectors.');
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== config.knowledge.embeddingDimensions
      || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
      || vector.every((value) => value === 0)) {
      throw new EmbeddingProviderError(`Embedding service must return finite non-zero vectors of ${config.knowledge.embeddingDimensions} dimensions.`);
    }
  }
  return vectors;
}

export function embedDocumentChunks(chunks, title, options = {}) {
  const inputs = chunks.map(({ chunkText }) => config.knowledge.documentEmbeddingPrefix
    .replaceAll('{title}', maskSensitiveText(title))
    .replaceAll('{text}', maskSensitiveText(chunkText)));
  return generateEmbeddings(inputs, options);
}

export function embedSearchQuery(query, options = {}) {
  const input = config.knowledge.queryEmbeddingPrefix.replaceAll('{query}', maskSensitiveText(query));
  return generateEmbeddings([input], options).then(([embedding]) => embedding);
}
