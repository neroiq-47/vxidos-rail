// One JSON object per line so Railway (and most log platforms) parse level and fields;
// a multi-line stack trace would otherwise become many separate "error" entries.
export function log(level, message, fields = {}) {
  const entry = {level, message, time: new Date().toISOString(), ...fields};
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(entry) + '\n');
}
export const logger = {
  info: (m, f) => log('info', m, f),
  warn: (m, f) => log('warn', m, f),
  error: (m, f) => log('error', m, f instanceof Error ? {error: f.message, stack: f.stack} : f)
};
