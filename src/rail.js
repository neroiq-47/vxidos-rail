import 'dotenv/config';
import OpenAI from 'openai';
import {BRAND} from './brand.js';
import {saveDraft} from './store.js';
export function validateDraft(text) {
  if (typeof text !== 'string' || text.trim().length < 12 || [...text.trim()].length > 280) throw new Error('Draft must be 12-280 characters');
  if (/https?:\/\//i.test(text)) throw new Error('Unapproved links are not permitted');
  if (/(guaranteed returns|risk.free profit|\$\d{6,} earned)/i.test(text)) throw new Error('Unverifiable financial claim');
  if (/[@#]{1}everyone\b/i.test(text)) throw new Error('Mass-mention text prohibited');
  return text.trim();
}
export async function generateDraft() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const client = new OpenAI({apiKey: process.env.OPENAI_API_KEY});
  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', temperature: 0.8,
    messages: [
      {role:'system', content:`You write for ${BRAND.name} (${BRAND.handle}). Brand voice: ${BRAND.voice}. Rules: ${BRAND.rules.join(' ')} Output exactly one tweet, no quotes or commentary.`},
      {role:'user', content:'Write one original, authentic post about discipline, creative work, or building online. Do not invent achievements.'}
    ]
  });
  return validateDraft(result.choices[0]?.message?.content || '');
}
export async function draftOnce() {
  const text = await generateDraft();
  return saveDraft(text);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  draftOnce().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
