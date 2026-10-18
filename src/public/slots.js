// Plans publish times: `perDay` evenly spaced slots inside a daily [from, to) window, in the runtime's
// local time (the browser's, so "09:00" means the viewer's 9am). Optional jitter of up to ±jitterMin
// minutes stays inside each slot, so order is preserved. Returns ISO strings, earliest first.
export function planSlots({count, start = new Date(), perDay = 8, from = '09:00', to = '23:00', jitterMin = 0, rand = Math.random}) {
  const mins = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const winMs = (mins(to) - mins(from)) * 60_000;
  if (!(winMs > 0)) throw new Error('window end must be after window start');
  if (!(perDay >= 1)) throw new Error('posts per day must be at least 1');
  const step = winMs / perDay, maxJitter = Math.max(0, Math.min(jitterMin * 60_000, step / 2 - 60_000));
  const earliest = start.getTime() + 2 * 60_000, out = [];
  for (let d = 0; out.length < count && d < 400; d++) {
    const day = new Date(start); day.setDate(day.getDate() + d); day.setHours(0, 0, 0, 0);
    const open = day.getTime() + mins(from) * 60_000; // re-derived per day so DST shifts don't drift slots
    for (let i = 0; i < perDay && out.length < count; i++) {
      const t = open + step * (i + 0.5) + (maxJitter ? (rand() * 2 - 1) * maxJitter : 0);
      if (t >= earliest) out.push(new Date(Math.round(t / 60_000) * 60_000).toISOString());
    }
  }
  return out;
}
