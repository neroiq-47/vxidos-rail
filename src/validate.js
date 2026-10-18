import {badRequest} from './errors.js';
import {tweetLength, TWEET_MAX} from './public/tweetlen.js';
export const MAX_CHARS = TWEET_MAX;
export const MIN_CHARS = 12;
const QUOTES = /^["'“”‘’`]+|["'“”‘’`]+$/g;
// LLMs often wrap the post in quotes or prefix it; strip that before validating.
export function cleanDraft(text) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/^(tweet|post|draft)\s*:\s*/i, '').replace(QUOTES, '').trim();
}
export function validateDraft(text) {
  const t = cleanDraft(text);
  if ([...t].length < MIN_CHARS) throw badRequest(`Draft must be at least ${MIN_CHARS} characters`);
  const len = tweetLength(t);
  if (len > MAX_CHARS) throw badRequest(`Draft is ${len}/${MAX_CHARS} characters as X counts them (emoji count as 2)`);
  if (/https?:\/\/|www\.\S+/i.test(t)) throw badRequest('Unapproved links are not permitted');
  if (/(guaranteed (returns|profit|income)|risk.free profit|\$\d{1,3}(,\d{3}){1,}\+? (earned|made|profit)|\$\d{6,} earned|\d+x your money)/i.test(t)) throw badRequest('Unverifiable financial claim');
  if (/[@#]everyone\b/i.test(t)) throw badRequest('Mass-mention text prohibited');
  if ((t.match(/(^|\s)@\w+/g) || []).length > 2) throw badRequest('Too many mentions');
  if ((t.match(/(^|\s)#\w+/g) || []).length > 2) throw badRequest('Too many hashtags');
  return t;
}
export const isReviewer = r => typeof r === 'string' && /^[a-zA-Z0-9_-]{2,64}$/.test(r);
export const isId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
