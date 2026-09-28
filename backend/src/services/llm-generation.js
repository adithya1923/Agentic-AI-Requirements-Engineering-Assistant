import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';

const providers = new Set(['gemini', 'groq', 'ollama']);
const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const providerCooldowns = new Map();

export function clearProviderHealthCache() { providerCooldowns.clear(); }

export class LlmGenerationError extends Error {
  constructor(message, code, status = 503, details = {}) {
    super(message);
    this.name = 'LlmGenerationError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function configuredProviderOrder(settings = config.generation) {
  const requested = [settings.provider, ...(settings.fallbacks || [])].map((name) => String(name).toLowerCase());
  const order = [...new Set(requested)];
  const unknown = order.find((name) => !providers.has(name));
  if (unknown) throw new LlmGenerationError('The configured LLM generation provider is unsupported.', 'LLM_PROVIDER_INVALID', 500);
  return order;
}

export async function generateStructuredOutput({ systemPrompt, userPrompt, responseSchema, ollamaFormat, maxTokens, modelPurpose }, options = {}) {
  const settings = {
    provider: config.generation.provider,
    fallbacks: config.generation.fallbacks,
    ollamaBaseUrl: config.generation.ollamaBaseUrl,
    model: config.generation.model,
    geminiApiKey: config.generation.geminiApiKey,
    geminiModel: config.generation.geminiModel,
    groqBaseUrl: config.generation.groqBaseUrl,
    groqApiKey: config.generation.groqApiKey,
    groqModel: config.generation.groqModel,
    timeoutMillis: config.generation.timeoutMillis,
    retryAttempts: config.generation.retryAttempts,
    retryMaxDelayMillis: config.generation.retryMaxDelayMillis,
    ...options,
  };
  const order = configuredProviderOrder(settings);
  const failures = [];

  for (const provider of order) {
    if (options.providerState?.get(provider) === 'unavailable') {
      const priorError = options.providerFailureState?.get(provider);
      if (priorError) failures.push({ provider, error: priorError });
      continue;
    }
    const cachedFailure = providerCooldowns.get(provider);
    if (cachedFailure && cachedFailure.until > Date.now()) {
      console.warn('LLM provider attempt skipped during health cooldown.', { provider, code: cachedFailure.error.code, status: cachedFailure.error.status });
      failures.push({ provider, error: cachedFailure.error });
      options.providerState?.set(provider, 'unavailable');
      options.providerFailureState?.set(provider, cachedFailure.error);
      continue;
    }
    if (cachedFailure) providerCooldowns.delete(provider);
    try {
      const model = getModel(provider, settings);
      const content = await generateWithProvider(provider, model, {
        systemPrompt, userPrompt, responseSchema, ollamaFormat, maxTokens, modelPurpose,
      }, settings);
      providerCooldowns.delete(provider);
      options.onProviderUsed?.({ provider, model });
      return content;
    } catch (error) {
      const normalized = normalizeProviderError(error);
      console.warn('LLM provider request failed.', { provider, code: normalized.code, status: normalized.status, upstreamCode: normalized.upstreamCode || null });
      failures.push({ provider, error: normalized });
      if (normalized.retryable) {
        options.providerState?.set(provider, 'unavailable');
        options.providerFailureState?.set(provider, normalized);
        providerCooldowns.set(provider, {
          error: providerFailure(normalized.message, normalized.code, normalized.status, provider, true),
          until: Date.now() + config.generation.providerHealthCacheMillis,
        });
      }
      if (!normalized.retryable) throw normalized;
    }
  }
  throw allProvidersFailed(failures);
}

async function generateWithProvider(provider, model, request, settings) {
  const maxAttempts = provider === 'ollama' ? 1 : settings.retryAttempts;
  const providerSettings = {
    ...settings,
    timeoutMillis: settings.providerTimeouts?.[provider] || settings.timeoutMillis,
  };
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (provider === 'gemini') return await callGemini(model, request, providerSettings);
      if (provider === 'groq') return await callGroq(model, request, providerSettings);
      return await callOllama(model, request, providerSettings);
    } catch (error) {
      lastError = normalizeProviderError(error, provider);
      const canRetry = lastError.retryable && lastError.code !== 'LLM_API_KEY_MISSING' && attempt + 1 < maxAttempts;
      if (!canRetry) throw lastError;
      const delay = Math.min(settings.retryMaxDelayMillis, retryDelay(lastError.retryAfter, attempt));
      if (delay > 0) await (settings.sleepImpl || sleep)(delay);
    }
  }
  throw lastError;
}

async function callGemini(model, request, settings) {
  if (!settings.geminiApiKey) throw providerFailure('GEMINI_API_KEY is not configured.', 'LLM_API_KEY_MISSING', 503, 'gemini', true);
  let ai;
  try {
    ai = settings.geminiClientFactory
      ? settings.geminiClientFactory(settings.geminiApiKey)
      : new GoogleGenAI({ apiKey: settings.geminiApiKey });
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      config: {
        ...(request.systemPrompt ? { systemInstruction: request.systemPrompt } : {}),
        temperature: 0,
        responseMimeType: 'application/json',
        responseJsonSchema: stripUnsupportedJsonSchema(request.responseSchema),
        ...(Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? { maxOutputTokens: request.maxTokens } : {}),
        thinkingConfig: { thinkingLevel: 'LOW' },
        httpOptions: { timeout: settings.timeoutMillis, retryOptions: { attempts: 1 } },
      },
    });
    const content = typeof response.text === 'string' ? response.text : '';
    if (!content.trim()) throw providerFailure('The configured LLM provider returned no structured content.', 'LLM_INVALID_RESPONSE', 502, 'gemini', true);
    return content;
  } catch (error) {
    throw normalizeProviderError(error, 'gemini');
  }
}

async function callGroq(model, request, settings) {
  if (!settings.groqApiKey) throw providerFailure('GROQ_API_KEY is not configured.', 'LLM_API_KEY_MISSING', 503, 'groq', true);
  const isGptOss = model.startsWith('openai/gpt-oss-');
  const schemaModels = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  const response = await fetchWithTimeout(settings.fetchImpl || fetch, `${settings.groqBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.groqApiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userPrompt }],
      stream: false,
      temperature: 0,
      ...(isGptOss ? { reasoning_effort: 'low', max_completion_tokens: 2048, include_reasoning: false }
        : Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? { max_tokens: request.maxTokens } : {}),
      response_format: schemaModels.has(model)
        ? { type: 'json_schema', json_schema: { name: request.modelPurpose === 'requirement-analysis' ? 'phase6_requirement_analysis' : 'structured_output', strict: true, schema: toGroqStrictSchema(request.responseSchema) } }
        : { type: 'json_object' },
    }),
  }, settings.timeoutMillis);
  if (!response.ok) throw await httpProviderError(response, 'groq', settings.groqApiKey);
  const payload = await parseResponse(response, 'groq');
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw providerFailure('The configured LLM provider returned no structured content.', 'LLM_INVALID_RESPONSE', 502, 'groq', true);
  return content;
}

async function callOllama(model, request, settings) {
  const response = await fetchWithTimeout(settings.fetchImpl || fetch, `${settings.ollamaBaseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userPrompt }],
      stream: false,
      format: request.responseSchema || request.ollamaFormat,
      options: { temperature: 0, ...(Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? { num_predict: request.maxTokens } : {}) },
    }),
  }, settings.timeoutMillis);
  if (!response.ok) throw await httpProviderError(response, 'ollama');
  const payload = await parseResponse(response, 'ollama');
  const content = payload?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw providerFailure('The configured LLM provider returned no structured content.', 'LLM_INVALID_RESPONSE', 502, 'ollama', true);
  return content;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMillis) {
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMillis) });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw providerFailure('The configured LLM provider timed out.', 'LLM_TIMEOUT', 504, undefined, true);
    throw providerFailure('The configured LLM provider is unavailable.', 'LLM_PROVIDER_UNAVAILABLE', 503, undefined, true);
  }
}

async function parseResponse(response, provider) {
  try { return await response.json(); }
  catch { throw providerFailure('The configured LLM provider returned an invalid response.', 'LLM_INVALID_RESPONSE', 502, provider, true); }
}

async function httpProviderError(response, provider, apiKey = '') {
  let upstream;
  try { upstream = await response.json(); } catch { upstream = {}; }
  const upstreamError = upstream?.error || {};
  const status = response.status;
  const retryable = transientStatuses.has(status) || [401, 403, 404].includes(status) || status >= 500;
  const error = providerFailure(
    retryable ? `${providerLabel(provider)} is unavailable (HTTP ${status}).` : `The configured LLM provider rejected the request (HTTP ${status}).`,
    retryable ? (status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_PROVIDER_UNAVAILABLE') : 'LLM_PROVIDER_ERROR',
    status === 429 ? 429 : status >= 500 ? 503 : 502,
    provider,
    retryable,
  );
  error.retryAfter = response.headers?.get('retry-after');
  error.upstreamCode = sanitize(upstreamError.code || upstreamError.status, apiKey);
  return error;
}

function normalizeProviderError(error, provider) {
  if (error instanceof LlmGenerationError) {
    if (provider && !error.provider) error.provider = provider;
    return error;
  }
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status)) {
    const retryable = transientStatuses.has(status) || [401, 403, 404].includes(status) || status >= 500;
    const normalized = providerFailure(retryable ? `${providerLabel(provider || 'configured LLM provider')} is unavailable (HTTP ${status}).` : `The configured LLM provider rejected the request (HTTP ${status}).`, status === 429 ? 'LLM_RATE_LIMITED' : retryable ? 'LLM_PROVIDER_UNAVAILABLE' : 'LLM_PROVIDER_ERROR', status === 429 ? 429 : status >= 500 ? 503 : 502, provider, retryable);
    normalized.retryAfter = error?.headers?.get?.('retry-after') || error?.headers?.['retry-after'];
    return normalized;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return providerFailure('The configured LLM provider timed out.', 'LLM_TIMEOUT', 504, provider, true);
  return providerFailure('The configured LLM provider is unavailable.', 'LLM_PROVIDER_UNAVAILABLE', 503, provider, true);
}

function allProvidersFailed(failures) {
  const timeoutOnly = failures.length > 0 && failures.every(({ error }) => error.code === 'LLM_TIMEOUT');
  const rateLimited = failures.some(({ error }) => error.code === 'LLM_RATE_LIMITED');
  const summary = failures.map(({ provider, error }) => {
    const result = error.code === 'LLM_TIMEOUT' ? 'timed out'
      : Number.isInteger(error.status) ? `HTTP ${error.status}` : error.code;
    return `${providerLabel(provider)}: ${result}`;
  }).join('; ');
  const message = rateLimited
    ? 'LLM provider quota exceeded. Please retry later.'
    : timeoutOnly ? 'LLM provider timed out while processing the request.' : 'LLM provider is temporarily unavailable.';
  return new LlmGenerationError(message, rateLimited ? 'LLM_RATE_LIMITED' : timeoutOnly ? 'LLM_TIMEOUT' : 'LLM_ALL_PROVIDERS_FAILED', timeoutOnly ? 504 : 503, { failures: failures.map(({ provider, error }) => ({ provider, code: error.code, status: error.status })) });
}

function providerFailure(message, code, status, provider, retryable) {
  return new LlmGenerationError(message, code, status, { provider, retryable });
}

function getModel(provider, settings) {
  if (provider === 'gemini') return settings.geminiModel;
  if (provider === 'groq') return settings.groqModel;
  return settings.model;
}

function providerLabel(provider) { return provider === 'gemini' ? 'Gemini' : provider === 'groq' ? 'Groq' : provider === 'ollama' ? 'Ollama' : 'The configured LLM provider'; }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function retryDelay(retryAfter, attempt) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return 250 * (2 ** attempt);
}

function sanitize(value, secret = '') {
  if (value === undefined || value === null) return '';
  let result = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (secret) result = result.split(secret).join('[redacted]');
  return result.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/\b(?:gsk_|sk-|AIza)[A-Za-z0-9_-]{16,}\b/gi, '[redacted secret]').slice(0, 120);
}

function stripUnsupportedJsonSchema(schema) {
  const allowed = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'title', 'description', 'enum', 'properties', 'required', 'items', 'anyOf', 'oneOf', 'format', 'minimum', 'maximum', 'minItems', 'maxItems', 'additionalProperties']);
  if (Array.isArray(schema)) return schema.map(stripUnsupportedJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!allowed.has(key)) continue;
    result[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, stripUnsupportedJsonSchema(child)]))
      : stripUnsupportedJsonSchema(value);
  }
  if (result.type === 'object' && result.properties && !result.required) result.required = Object.keys(result.properties);
  return result;
}

function toGroqStrictSchema(schema) {
  const supported = new Set(['type', 'enum', 'properties', 'required', 'items', 'additionalProperties']);
  if (Array.isArray(schema)) return schema.map(toGroqStrictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const nullable = Array.isArray(schema.anyOf) && schema.anyOf.some((branch) => branch?.type === 'null');
  const nonNull = nullable ? schema.anyOf.find((branch) => branch?.type !== 'null') : null;
  const source = nonNull ? { ...nonNull, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'anyOf')) } : schema;
  const output = Object.fromEntries(Object.entries(source).filter(([key]) => supported.has(key)).map(([key, value]) => [key, key === 'properties'
    ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, toGroqStrictSchema(child)]))
    : toGroqStrictSchema(value)]));
  if (output.type === 'object') {
    output.additionalProperties = false;
    output.required = Object.keys(output.properties || {});
  }
  if (nullable) output.type = [output.type || 'string', 'null'];
  return output;
}
