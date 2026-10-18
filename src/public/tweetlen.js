// Character count the way X counts it (twitter-text v3 weighting), shared by the server and the dashboard.
// Most Latin/punctuation code points count 1; everything else (CJK, many scripts) counts 2;
// each emoji counts 2 however many code points it is built from; text is NFC-normalised first.
export const TWEET_MAX = 280;
const LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const graphemes = s => segmenter ? Array.from(segmenter.segment(s), x => x.segment) : [...s];
const weight = cp => LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;

export function tweetLength(text) {
  let n = 0;
  for (const g of graphemes(String(text ?? '').normalize('NFC'))) {
    if (EMOJI.test(g)) { n += 2; continue; }
    for (const ch of g) n += weight(ch.codePointAt(0));
  }
  return n;
}
