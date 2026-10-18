import {randomUUID} from 'node:crypto';

// Runs batch work (e.g. 100 Buffer sends) in the background at a steady pace, with progress and cancel.
// In memory only: a restart ends a running job, and anything not yet sent simply stays approved.
export function createJobRunner({paceMs = 10_000, sleep = ms => new Promise(r => setTimeout(r, ms)), keep = 20} = {}) {
  const jobs = new Map();
  const view = j => ({id: j.id, kind: j.kind, state: j.state, total: j.total, done: j.done, results: j.results, errors: j.errors, startedAt: j.startedAt, finishedAt: j.finishedAt});
  const running = () => [...jobs.values()].find(j => j.state === 'running');

  // fn(item, index) does one unit of work; an error with stop=true (or status 429/400) ends the job.
  function start(kind, items, fn) {
    const j = {id: randomUUID(), kind, state: 'running', total: items.length, done: 0, results: [], errors: [], startedAt: new Date().toISOString(), cancel: false};
    jobs.set(j.id, j);
    if (jobs.size > keep) jobs.delete(jobs.keys().next().value);
    (async () => {
      for (const [i, item] of items.entries()) {
        if (j.cancel) { j.state = 'cancelled'; break; }
        if (i) await sleep(paceMs);
        if (j.cancel) { j.state = 'cancelled'; break; }
        try { j.results.push(await fn(item, i)); }
        catch (e) {
          j.errors.push(e.message);
          if (e.stop || e.status === 429 || e.status === 400) { j.state = 'stopped'; break; }
        }
        j.done = i + 1;
      }
      if (j.state === 'running') j.state = 'done';
      j.finishedAt = new Date().toISOString();
    })().catch(e => { j.state = 'failed'; j.errors.push(e.message); j.finishedAt = new Date().toISOString(); });
    return view(j);
  }
  return {
    start, running: () => running() && view(running()),
    get: id => jobs.has(id) ? view(jobs.get(id)) : null,
    list: () => [...jobs.values()].reverse().map(view),
    cancel: id => { const j = jobs.get(id); if (j && j.state === 'running') j.cancel = true; return j ? view(j) : null; }
  };
}
