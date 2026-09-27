import { config } from '../config.js';

export function chunkDocumentText(input, options = {}) {
  const maxChars = options.maxChars ?? config.knowledge.maxChunkChars;
  const overlapChars = options.overlapChars ?? config.knowledge.chunkOverlapChars;
  if (!Number.isInteger(maxChars) || maxChars < 200) throw new RangeError('Chunk size must be at least 200 characters');
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError('Chunk overlap must be non-negative and smaller than chunk size');
  }

  const text = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!text) return [];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const preferredBoundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf(' ', end));
      if (preferredBoundary > start + Math.floor(maxChars * 0.6)) end = preferredBoundary;
    }
    const rawChunk = text.slice(start, end);
    const contentStart = rawChunk.length - rawChunk.trimStart().length;
    const contentEnd = rawChunk.trimEnd().length;
    const chunkText = rawChunk.slice(contentStart, contentEnd);
    if (chunkText) {
      chunks.push({
        chunkIndex: chunks.length,
        chunkText,
        metadata: { charStart: start + contentStart, charEnd: start + contentEnd, chunking: 'fixed-character-window-v1' },
      });
    }
    if (end >= text.length) break;
    const nextStart = Math.max(start + 1, end - overlapChars);
    start = nextStart;
  }
  return chunks;
}
