/** Connectives and legal suffixes that say nothing about who a party is. */
const NOISE = new Set([
  'MR',
  'MRS',
  'MS',
  'DR',
  'AL',
  'EL',
  'BIN',
  'BEN',
  'IBN',
  'BINT',
  'LLC',
  'LTD',
  'LIMITED',
  'FZE',
  'FZCO',
  'FZC',
  'DMCC',
  'INC',
  'CO',
  'COMPANY',
]);

/** Upper case, no accents or punctuation, without noise words unless nothing else would remain. */
export function normaliseName(name: string): string {
  const tokens = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const meaningful = tokens.filter((token) => !NOISE.has(token));
  return (meaningful.length ? meaningful : tokens).join(' ');
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const end = Math.min(i + window + 1, b.length);
    for (let j = Math.max(0, i - window); j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Set so that Muhammad/Mohammed, which scores 0.85, is safely inside.
const TOKEN_FLOOR = 0.84;
/** One shared word against a longer name is weak evidence, however exact it is. */
const PARTIAL_NAME_FACTOR = 0.7;

/**
 * Word-order independent similarity of two names already passed through normaliseName, from 0 to 1.
 * Each word of the shorter name pairs with its best unused counterpart in the longer one.
 */
export function nameSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const a = left.split(' ');
  const b = right.split(' ');
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let total = 0;
  for (const token of shorter) {
    let best = 0;
    let bestIndex = -1;
    longer.forEach((candidate, index) => {
      if (used.has(index)) return;
      const score = jaroWinkler(token, candidate);
      if (score > best) {
        best = score;
        bestIndex = index;
      }
    });
    if (best < TOKEN_FLOOR) return 0;
    used.add(bestIndex);
    total += best;
  }
  const score = total / shorter.length;
  return shorter.length === 1 && longer.length > 1 ? score * PARTIAL_NAME_FACTOR : score;
}
