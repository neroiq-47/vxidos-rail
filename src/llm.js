import OpenAI from 'openai';
import {HttpError} from './errors.js';
import {logger} from './log.js';

// Free OpenAI-compatible fallbacks. Model names rotate on free tiers, so FALLBACK_LLM_MODEL overrides the default.
export const PRESETS = Object.freeze({
  groq: {baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile'},
  gemini: {baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash'}
});
const COOLDOWN_MS = 5 * 60_000;

// Ordered provider list from env: OpenAI first (if keyed), then the free fallback (if keyed).
export function providersFromEnv(env = process.env) {
  const list = [];
  if (env.OPENAI_API_KEY) list.push({name: 'openai', apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || 'gpt-4.1-mini', maxTokens: 120});
  const kind = (env.FALLBACK_LLM_PROVIDER || '').toLowerCase();
  if (kind && env.FALLBACK_LLM_API_KEY) {
    const preset = PRESETS[kind] || {};
    const baseURL = env.FALLBACK_LLM_BASE_URL || preset.baseURL;
    const model = env.FALLBACK_LLM_MODEL || preset.model;
    if (!baseURL || !model) throw new Error(`FALLBACK_LLM_PROVIDER=${kind} needs FALLBACK_LLM_BASE_URL and FALLBACK_LLM_MODEL`);
    // Larger budget: some free models spend tokens on reasoning before the answer.
    list.push({name: kind, apiKey: env.FALLBACK_LLM_API_KEY, baseURL, model, maxTokens: 1024});
  }
  return list;
}

const clients = new Map();
function defaultCall(p, messages) {
  const key = `${p.name}|${p.baseURL || ''}`;
  if (!clients.has(key)) clients.set(key, new OpenAI({apiKey: p.apiKey, baseURL: p.baseURL, timeout: 30_000, maxRetries: 1}));
  return clients.get(key).chat.completions.create({model: p.model, temperature: 0.9, max_tokens: p.maxTokens, messages})
    .then(r => r.choices[0]?.message?.content || '');
}

// Tries providers in order. A provider that fails is skipped for COOLDOWN_MS so an exhausted
// OpenAI quota doesn't add a failed round-trip to every draft; if all are cooling down, try them anyway.
export function createGenerator({providers = providersFromEnv(), call = defaultCall, now = Date.now} = {}) {
  const failedAt = new Map();
  return async function generate(messages) {
    if (!providers.length) throw new HttpError(503, 'No LLM configured: set OPENAI_API_KEY or FALLBACK_LLM_PROVIDER + FALLBACK_LLM_API_KEY');
    const ready = providers.filter(p => !(now() - (failedAt.get(p.name) ?? -Infinity) < COOLDOWN_MS));
    const errors = [];
    for (const p of ready.length ? ready : providers) {
      try {
        const text = await call(p, messages);
        failedAt.delete(p.name);
        return {text, provider: p.name, model: p.model};
      } catch (e) {
        failedAt.set(p.name, now());
        errors.push(`${p.name}: ${e.message}`);
        logger.warn('llm provider failed', {provider: p.name, model: p.model, status: e.status, error: e.message});
      }
    }
    throw new HttpError(502, `Generation failed (${errors.join('; ')})`);
  };
}
