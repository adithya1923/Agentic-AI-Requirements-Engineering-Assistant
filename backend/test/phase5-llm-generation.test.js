import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { config } from '../src/config.js';
import { clearProviderHealthCache, configuredProviderOrder, generateStructuredOutput, LlmGenerationError } from '../src/services/llm-generation.js';
import { requirementResponseSchema } from '../src/services/requirement-extraction.js';

const request = {
  systemPrompt: 'Extract requirements only.',
  userPrompt: 'Source: The service shall show status.',
  responseSchema: requirementResponseSchema,
  maxTokens: 700,
  modelPurpose: 'requirements-intelligence',
};

beforeEach(() => clearProviderHealthCache());

test('provider order is configurable and duplicate providers are removed', () => {
  assert.deepEqual(configuredProviderOrder({ provider: 'gemini', fallbacks: ['groq', 'ollama', 'groq'] }), ['gemini', 'groq', 'ollama']);
  assert.throws(() => configuredProviderOrder({ provider: 'wrong', fallbacks: [] }), (error) => error.code === 'LLM_PROVIDER_INVALID');
  assert.equal(config.generation.geminiModel, process.env.GEMINI_MODEL || 'gemini-3.8-flash');
});

test('Gemini uses the official SDK generateContent structured JSON API and the unchanged application schema', async () => {
  let captured;
  let used;
  const content = '{"requirements":[]}';
  const result = await generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: [], geminiApiKey: 'test-key', geminiModel: 'gemini-test',
    geminiClientFactory: (apiKey) => {
      assert.equal(apiKey, 'test-key');
      return { models: { generateContent: async (params) => { captured = params; return { text: content }; } } };
    },
    onProviderUsed: (metadata) => { used = metadata; },
  });
  assert.equal(result, content);
  assert.equal(captured.model, 'gemini-test');
  assert.equal(captured.contents[0].parts[0].text, request.userPrompt);
  assert.equal(captured.config.responseMimeType, 'application/json');
  assert.deepEqual(captured.config.responseJsonSchema.properties.requirements.items.properties.candidateId, { type: 'string' });
  assert.equal(Object.hasOwn(captured.config.responseJsonSchema.properties.requirements.items.properties, 'requirementText'), false);
  assert.equal(captured.config.responseJsonSchema.additionalProperties, false);
  assert.deepEqual(used, { provider: 'gemini', model: 'gemini-test' });
});

test('Gemini structured output preserves the application schema for the unified workflow', async () => {
  for (const responseSchema of [requirementResponseSchema, requirementResponseSchema]) {
    let capturedSchema;
    await generateStructuredOutput({ ...request, responseSchema }, {
      provider: 'gemini', fallbacks: [], geminiApiKey: 'test-key',
      geminiClientFactory: () => ({ models: { generateContent: async (params) => { capturedSchema = params.config.responseJsonSchema; return { text: '{}' }; } } }),
    });
    assert.equal(capturedSchema.type, 'object');
    assert.equal(capturedSchema.properties.requirements.type, 'array');
    assert.equal(responseSchema.additionalProperties, false);
  }
});

test('Gemini transient 429 honors Retry-After, retries once, and then succeeds', async () => {
  let calls = 0;
  const delays = [];
  const result = await generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: [], geminiApiKey: 'test-key', retryAttempts: 2, retryMaxDelayMillis: 50,
    sleepImpl: async (ms) => delays.push(ms),
    geminiClientFactory: () => ({ models: { generateContent: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('safe provider response'), { status: 429, headers: new Headers({ 'retry-after': '0.01' }) });
      return { text: '{"requirements":[]}' };
    } } }),
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10]);
});

test('400 schema errors are not retried and are not hidden by fallback', async () => {
  let calls = 0;
  await assert.rejects(generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: ['groq'], geminiApiKey: 'test-key',
    geminiClientFactory: () => ({ models: { generateContent: async () => { calls += 1; throw Object.assign(new Error('secret provider body'), { status: 400 }); } } }),
    fetchImpl: async () => { calls += 100; },
  }), (error) => error instanceof LlmGenerationError && error.code === 'LLM_PROVIDER_ERROR' && !error.message.includes('secret provider body'));
  assert.equal(calls, 1);
});

test('Gemini transient failure fails over to Groq and reports the actual provider/model', async () => {
  let used;
  let geminiCalls = 0;
  let groqCalls = 0;
  const result = await generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: ['groq', 'ollama'], geminiApiKey: 'gem-key', groqApiKey: 'groq-key', groqModel: 'openai/gpt-oss-120b',
    retryAttempts: 1, fetchImpl: async (_url, options) => {
      groqCalls += 1;
      assert.equal(options.headers.authorization, 'Bearer groq-key');
      return Response.json({ choices: [{ message: { content: '{"requirements":[]}', reasoning: 'ignored' } }] });
    },
    geminiClientFactory: () => ({ models: { generateContent: async () => { geminiCalls += 1; throw Object.assign(new Error('provider unavailable'), { status: 503 }); } } }),
    onProviderUsed: (metadata) => { used = metadata; },
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(geminiCalls, 1);
  assert.equal(groqCalls, 1);
  assert.deepEqual(used, { provider: 'groq', model: 'openai/gpt-oss-120b' });
});

test('Gemini timeout retries only within its limit and then fails over', async () => {
  let geminiCalls = 0;
  let groqCalls = 0;
  const delays = [];
  const result = await generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: ['groq'], geminiApiKey: 'test-key', groqApiKey: 'test-groq', retryAttempts: 2,
    sleepImpl: async (ms) => delays.push(ms),
    geminiClientFactory: () => ({ models: { generateContent: async () => { geminiCalls += 1; throw new DOMException('private timeout', 'TimeoutError'); } } }),
    fetchImpl: async () => { groqCalls += 1; return Response.json({ choices: [{ message: { content: '{"requirements":[]}' } }] }); },
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(geminiCalls, 2);
  assert.equal(groqCalls, 1);
  assert.deepEqual(delays, [250]);
});

test('Groq uses strict JSON schema and does not retry or leak upstream details for schema errors', async () => {
  let captured;
  await generateStructuredOutput({ ...request, modelPurpose: 'requirements-intelligence', responseSchema: requirementResponseSchema }, {
    provider: 'groq', fallbacks: [], groqApiKey: 'test-key', groqModel: 'openai/gpt-oss-20b',
      fetchImpl: async (_url, options) => { captured = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: '{"requirements":[]}' } }] }); },
  });
  assert.equal(captured.response_format.type, 'json_schema');
  assert.equal(captured.response_format.json_schema.strict, true);
  assert.equal(captured.reasoning_effort, 'low');
  assert.equal(captured.include_reasoning, false);

  let calls = 0;
  await assert.rejects(generateStructuredOutput(request, {
    provider: 'groq', fallbacks: ['ollama'], groqApiKey: 'test-key',
    fetchImpl: async () => { calls += 1; return Response.json({ error: { code: 'json_validate_failed', message: 'contains secret detail' } }, { status: 400 }); },
  }), (error) => error.code === 'LLM_PROVIDER_ERROR' && !error.message.includes('secret detail'));
  assert.equal(calls, 1);
});

test('Groq respects Retry-After on 429 and falls through on 503', async () => {
  let groqCalls = 0;
  let ollamaCalls = 0;
  const delays = [];
  const result = await generateStructuredOutput(request, {
    provider: 'groq', fallbacks: ['ollama'], groqApiKey: 'test-key', groqModel: 'llama-test',
    ollamaBaseUrl: 'http://ollama.test', model: 'local-test', retryAttempts: 2,
    sleepImpl: async (ms) => delays.push(ms),
    fetchImpl: async (url) => {
      if (url.includes('groq.test')) {
        groqCalls += 1;
        if (groqCalls === 1) return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '0.02' } });
        return new Response('{}', { status: 503 });
      }
      ollamaCalls += 1;
      return Response.json({ message: { content: '{"requirements":[]}' } });
    },
    groqBaseUrl: 'https://groq.test/openai/v1',
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(groqCalls, 2);
  assert.equal(ollamaCalls, 1);
  assert.deepEqual(delays, [20]);
});

test('Ollama sends a structured chat request and fails over after bounded timeout', async () => {
  let captured;
  const result = await generateStructuredOutput(request, {
    provider: 'ollama', fallbacks: [], ollamaBaseUrl: 'http://ollama.test/', model: 'local-model',
    fetchImpl: async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return Response.json({ message: { content: '{"requirements":[]}' } }); },
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(captured.url, 'http://ollama.test/api/chat');
  assert.deepEqual(captured.body.format, request.responseSchema);
  assert.notEqual(captured.body.format, 'json');
  assert.equal(captured.body.stream, false);

  const errors = [];
  await assert.rejects(generateStructuredOutput(request, {
    provider: 'ollama', fallbacks: ['gemini'], geminiApiKey: 'test-key', retryAttempts: 1,
    fetchImpl: async () => { throw new DOMException('private timeout details', 'TimeoutError'); },
    geminiClientFactory: () => ({ models: { generateContent: async () => { throw new Error('not used'); } } }),
    onProviderUsed: (metadata) => errors.push(metadata),
  }), (error) => error.code === 'LLM_ALL_PROVIDERS_FAILED' && !error.message.includes('private timeout details'));
  assert.deepEqual(errors, []);
});

test('Ollama prefers the response JSON Schema over JSON mode when both are provided', async () => {
  let body;
  await generateStructuredOutput({ ...request, ollamaFormat: 'json' }, {
    provider: 'ollama', fallbacks: [], ollamaBaseUrl: 'http://ollama.test', model: 'local-model',
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ message: { content: '{"requirements":[]}' } }); },
  });
  assert.deepEqual(body.format, request.responseSchema);
  assert.notEqual(body.format, 'json');
  assert.equal(body.stream, false);
});

test('Ollama JSON mode remains available when no response schema is supplied', async () => {
  let body;
  await generateStructuredOutput({ ...request, responseSchema: undefined, ollamaFormat: 'json' }, {
    provider: 'ollama', fallbacks: [], ollamaBaseUrl: 'http://ollama.test', model: 'local-model',
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return Response.json({ message: { content: '{"requirements":[]}' } }); },
  });
  assert.equal(body.format, 'json');
});

test('Ollama connection refusal immediately falls back without exposing connection details', async () => {
  let calls = 0;
  const result = await generateStructuredOutput(request, {
    provider: 'ollama', fallbacks: ['gemini'], geminiApiKey: 'test-key', retryAttempts: 3,
    fetchImpl: async () => { calls += 1; throw new Error('connection refused private detail'); },
    geminiClientFactory: () => ({ models: { generateContent: async () => ({ text: '{"requirements":[]}' }) } }),
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(calls, 1);
});

test('all-provider failure is bounded, sanitized, and reports quota exhaustion clearly', async () => {
  let calls = 0;
  const providerState = new Map();
  await assert.rejects(generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: ['groq', 'ollama'], geminiApiKey: 'secret-key', groqApiKey: 'secret-groq',
    retryAttempts: 1, providerState,
    geminiClientFactory: () => ({ models: { generateContent: async () => { calls += 1; throw Object.assign(new Error('secret-key'), { status: 429 }); } } }),
    fetchImpl: async () => { calls += 1; return Response.json({ error: { message: 'secret-groq' } }, { status: 429, headers: { 'retry-after': '99' } }); },
  }), (error) => error.code === 'LLM_RATE_LIMITED' && error.status === 503 && error.message.includes('quota exceeded')
    && !error.message.includes('secret-key') && !error.message.includes('secret-groq'));
  assert.equal(calls, 3);
  assert.equal(providerState.get('gemini'), 'unavailable');
  assert.equal(providerState.get('groq'), 'unavailable');
  assert.equal(providerState.get('ollama'), 'unavailable');
});

test('a short provider-health cache prevents duplicate quota attempts across adjacent requests', async () => {
  let geminiCalls = 0;
  let groqCalls = 0;
  await assert.rejects(generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: [], geminiApiKey: 'test-key', retryAttempts: 1,
    geminiClientFactory: () => ({ models: { generateContent: async () => { geminiCalls += 1; throw Object.assign(new Error('quota'), { status: 429 }); } } }),
  }), (error) => error.code === 'LLM_RATE_LIMITED');

  const result = await generateStructuredOutput(request, {
    provider: 'gemini', fallbacks: ['groq'], geminiApiKey: 'test-key', groqApiKey: 'test-groq', retryAttempts: 1,
    geminiClientFactory: () => ({ models: { generateContent: async () => { geminiCalls += 1; return { text: 'not used' }; } } }),
    fetchImpl: async () => { groqCalls += 1; return Response.json({ choices: [{ message: { content: '{"requirements":[]}' } }] }); },
  });
  assert.equal(result, '{"requirements":[]}');
  assert.equal(geminiCalls, 1);
  assert.equal(groqCalls, 1);
});
