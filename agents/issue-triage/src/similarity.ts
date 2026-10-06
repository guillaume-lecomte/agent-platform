const STOPWORDS = new Set(
  'a an the and or of to in on at for with from by is are was were be been it its this that these those i we you my our your after before when while if then than so as not no do does did can could should would will just also into out up down over under again more most some any have has had get gets got using use used'.split(
    ' ',
  ),
);

/** Lowercased word tokens, minus stopwords, with a crude plural/-ing/-ed stemmer. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
    .filter((w) => w.length > 1);
}

/**
 * Score in 0..1: the share of the query's distinct tokens found in the candidate text,
 * damped when fewer than three tokens match, so that one shared word ("sync") is never
 * enough to call two issues similar. Cheap and deterministic: it stands in for a real
 * issue-search backend.
 */
export function containment(query: string, candidate: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const c = new Set(tokenize(candidate));
  let hits = 0;
  for (const t of q) if (c.has(t)) hits++;
  return (hits / q.size) * Math.min(1, hits / 3);
}
