import 'dotenv/config';
import OpenAI from 'openai';
import {BRAND, PILLARS} from './brand.js';
import {saveDraft, listDrafts} from './store.js';
import {validateDraft} from './validate.js';
import {HttpError, badRequest} from './errors.js';
export {validateDraft} from './validate.js';

let client;
const openai = () => {
  if (!process.env.OPENAI_API_KEY) throw new HttpError(503, 'OPENAI_API_KEY missing');
  return client ||= new OpenAI({apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 2});
};

export function buildMessages(pillar, recent = []) {
  const avoid = recent.length ? ` Do not repeat or closely paraphrase these recent posts:\n${recent.map(t => `- ${t}`).join('\n')}` : '';
  return [
    {role: 'system', content: `You write for ${BRAND.name} (${BRAND.handle}). Brand voice: ${BRAND.voice}. Rules: ${BRAND.rules.join(' ')} Output exactly one post, no quotes or commentary.`},
    {role: 'user', content: `Write one original, authentic post. Theme: ${pillar}. Do not invent achievements.${avoid}`}
  ];
}

export async function generateDraft({pillar, recent} = {}) {
  const result = await openai().chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', temperature: 0.9, max_tokens: 120,
    messages: buildMessages(pillar, recent)
  });
  return result.choices[0]?.message?.content || '';
}

// Rotate to whichever pillar has been used least recently.
export function nextPillar(drafts) {
  const last = new Map(PILLARS.map(p => [p, '']));
  for (const d of drafts) if (last.has(d.pillar) && d.createdAt > last.get(d.pillar)) last.set(d.pillar, d.createdAt);
  return [...last].sort((a, b) => a[1].localeCompare(b[1]))[0][0];
}

export async function draftOnce({pillar, generate = generateDraft, attempts = 3, source = 'manual'} = {}) {
  if (pillar && !PILLARS.includes(pillar)) throw badRequest('Unknown pillar');
  const drafts = await listDrafts();
  pillar ||= nextPillar(drafts);
  const recent = drafts.slice(0, 10).map(d => d.text);
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      let raw;
      // Upstream errors carry their own HTTP status (e.g. OpenAI 401); never let that leak as ours.
      try { raw = await generate({pillar, recent}); }
      catch (e) { throw e instanceof HttpError ? e : new HttpError(502, `Generation failed: ${e.message}`); }
      const text = validateDraft(raw);
      return await saveDraft(text, {pillar, source});
    } catch (e) {
      // Only retry content problems (validation/duplicate); auth/network errors and caps (429) fail fast.
      if (!e.status || e.status >= 500 || e.status === 429) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

export async function draftBatch(count = 1, opts = {}) {
  if (opts.pillar && !PILLARS.includes(opts.pillar)) throw badRequest('Unknown pillar');
  const drafts = [], errors = [];
  for (let i = 0; i < count; i++) {
    try { drafts.push(await draftOnce(opts)); }
    catch (e) {
      if (!e.status || e.status >= 500 || e.status === 429) { if (!drafts.length) throw e; errors.push(e.message); break; }
      errors.push(e.message);
    }
  }
  return {drafts, errors};
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const count = Math.min(Math.max(Number(process.argv[2]) || 1, 1), 5);
  draftBatch(count, {source: 'cli'}).then(x => console.log(JSON.stringify(x, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
