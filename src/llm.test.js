import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerator, providersFromEnv, PRESETS} from './llm.js';

test('providersFromEnv: openai first, then free fallback preset', () => {
  const ps = providersFromEnv({OPENAI_API_KEY: 'o', FALLBACK_LLM_PROVIDER: 'groq', FALLBACK_LLM_API_KEY: 'g'});
  assert.deepEqual(ps.map(p => p.name), ['openai', 'groq']);
  assert.equal(ps[1].baseURL, PRESETS.groq.baseURL);
  assert.equal(ps[1].model, PRESETS.groq.model);
  assert.equal(providersFromEnv({FALLBACK_LLM_PROVIDER: 'gemini', FALLBACK_LLM_API_KEY: 'k', FALLBACK_LLM_MODEL: 'm'})[0].model, 'm');
  assert.deepEqual(providersFromEnv({FALLBACK_LLM_PROVIDER: 'groq'}), [], 'no key, no fallback');
  assert.throws(() => providersFromEnv({FALLBACK_LLM_PROVIDER: 'other', FALLBACK_LLM_API_KEY: 'k'}), /BASE_URL/);
});

test('falls back when OpenAI fails, then skips it during cooldown', async () => {
  const calls = [];
  let t = 0;
  const gen = createGenerator({
    providers: [{name: 'openai', model: 'a'}, {name: 'groq', model: 'b'}],
    call: async p => { calls.push(p.name); if (p.name === 'openai') throw Object.assign(new Error('quota'), {status: 429}); return 'night shift.'; },
    now: () => t
  });
  assert.deepEqual(await gen([]), {text: 'night shift.', provider: 'groq', model: 'b'});
  await gen([]);
  assert.deepEqual(calls, ['openai', 'groq', 'groq'], 'openai skipped while cooling down');
  t = 6 * 60_000;
  await gen([]);
  assert.deepEqual(calls.slice(3), ['openai', 'groq'], 'openai retried after cooldown');
});

test('all providers failing is a 502 naming each; none configured is 503', async () => {
  const gen = createGenerator({providers: [{name: 'openai'}, {name: 'groq'}], call: async p => { throw new Error(`${p.name} down`); }});
  await assert.rejects(gen([]), e => e.status === 502 && /openai: openai down; groq: groq down/.test(e.message));
  await assert.rejects(createGenerator({providers: []})([]), e => e.status === 503);
});

test('real OpenAI client talks to the fallback base URL with the configured model', async () => {
  const {createServer} = await import('node:http');
  let seen;
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen = {path: req.url, auth: req.headers.authorization, body: JSON.parse(b)};
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({id: 'x', object: 'chat.completion', created: 0, model: seen.body.model, choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: 'quiet output.'}}]}));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const [p] = providersFromEnv({FALLBACK_LLM_PROVIDER: 'custom', FALLBACK_LLM_API_KEY: 'free-key', FALLBACK_LLM_BASE_URL: `http://127.0.0.1:${srv.address().port}/v1`, FALLBACK_LLM_MODEL: 'tiny'});
    const out = await createGenerator({providers: [p]})([{role: 'user', content: 'hi'}]);
    assert.equal(out.text, 'quiet output.');
    assert.equal(seen.path, '/v1/chat/completions'); assert.equal(seen.auth, 'Bearer free-key'); assert.equal(seen.body.model, 'tiny');
  } finally { srv.close(); }
});

test('every free preset has a base URL and default model; groq no longer uses the retired llama-3.3-70b', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.match(p.baseURL, /^https:\/\//, name); assert.ok(p.model, name);
    assert.equal(providersFromEnv({FALLBACK_LLM_PROVIDER: name, FALLBACK_LLM_API_KEY: 'k'})[0].model, p.model);
  }
  assert.deepEqual(Object.keys(PRESETS).sort(), ['cerebras', 'gemini', 'groq', 'openrouter']);
  assert.notEqual(PRESETS.groq.model, 'llama-3.3-70b-versatile');
});
