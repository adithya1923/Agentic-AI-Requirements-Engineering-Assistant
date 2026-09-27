import { config } from '../config.js';

export class LlmGenerationError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = 'LlmGenerationError';
    this.code = code;
    this.status = status;
  }
}

export async function generateStructuredOutput({ systemPrompt, userPrompt, responseSchema }, {
  fetchImpl = fetch,
  baseUrl = config.generation.ollamaBaseUrl,
  model = config.generation.model,
  timeoutMillis = config.generation.timeoutMillis,
} = {}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        format: responseSchema,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(timeoutMillis),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmGenerationError('The configured LLM provider timed out.', 'LLM_TIMEOUT', 504);
    }
    throw new LlmGenerationError('The configured LLM provider is unavailable.', 'LLM_PROVIDER_UNAVAILABLE', 503);
  }

  if (!response.ok) {
    throw new LlmGenerationError(`The configured LLM provider returned HTTP ${response.status}.`, 'LLM_PROVIDER_ERROR', 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new LlmGenerationError('The configured LLM provider returned an invalid response.', 'LLM_INVALID_RESPONSE', 502);
  }
  const content = payload?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LlmGenerationError('The configured LLM provider returned no structured content.', 'LLM_INVALID_RESPONSE', 502);
  }
  return content;
}
