import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { generateStructuredOutput, LlmGenerationError } from '../src/services/llm-generation.js';

const request = {
  systemPrompt: 'Extract requirements only.',
  userPrompt: 'Source: The service shall show status.',
  responseSchema: { type: 'object', additionalProperties: false, properties: { requirements: { type: 'array' } }, required: ['requirements'] },
};

test('Ollama generation uses the separate configured chat model and structured response schema', async () => {
  let captured;
  const content = '{"requirements":[]}';
  const result = await generateStructuredOutput(request, {
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return Response.json({ message: { content } });
    },
  });
  assert.equal(result, content);
  assert.equal(captured.url, `${config.generation.ollamaBaseUrl}/api/chat`);
  assert.equal(captured.body.model, config.generation.model);
  assert.notEqual(captured.body.model, config.knowledge.embeddingModel);
  assert.equal(captured.body.stream, false);
  assert.deepEqual(captured.body.format, request.responseSchema);
  assert.equal(captured.body.options.temperature, 0);
});

test('Ollama generation timeout, connection, HTTP, and malformed response failures are safe', async () => {
  await assert.rejects(generateStructuredOutput(request, {
    fetchImpl: async () => { throw new DOMException('timeout detail', 'TimeoutError'); },
  }), (error) => error instanceof LlmGenerationError && error.code === 'LLM_TIMEOUT' && !error.message.includes('timeout detail'));
  await assert.rejects(generateStructuredOutput(request, {
    fetchImpl: async () => { throw new Error('private connection detail'); },
  }), (error) => error.code === 'LLM_PROVIDER_UNAVAILABLE' && !error.message.includes('private connection detail'));
  await assert.rejects(generateStructuredOutput(request, {
    fetchImpl: async () => new Response('raw provider detail', { status: 500 }),
  }), (error) => error.code === 'LLM_PROVIDER_ERROR' && !error.message.includes('raw provider detail'));
  await assert.rejects(generateStructuredOutput(request, {
    fetchImpl: async () => Response.json({ message: {} }),
  }), (error) => error.code === 'LLM_INVALID_RESPONSE');
});
