import runbookData from "../runbooks/runbooks.json";

export interface Runbook {
  id: string;
  title: string;
  service: string;
  symptoms: string[];
  checks: string[];
  safeActions: string[];
  escalation: string;
}

export interface RunbookMatch {
  runbook: Runbook;
  score: number;
  matchedTerms: string[];
}

export const RUNBOOKS = runbookData as Runbook[];

/** A hit needs at least one title/symptom-strength match to count as relevant. */
const MIN_SCORE = 3;

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our out over please should so than that the their them then there these they this those to " +
    "up us was we were what when where which while who why will with would you your seeing see seen getting get " +
    "got users user report reports reported began begin started start some any all after before about again " +
    "check checks look looking help need needs issue issues problem problems what's"
  ).split(/\s+/),
);

// Field weights: what the engineer sees (title/symptoms) matters most.
const W_TITLE = 3;
const W_SYMPTOM = 3;
const W_SERVICE = 2;
const W_CHECK = 1;
const W_ACTION = 1;
const W_ESCALATION = 0.5;

/** Light normalisation so "failures"/"failing"/"fail" and "502s"/"502" line up. */
function stem(token: string): string {
  if (/^\d/.test(token)) return token.replace(/s$/, "");
  let t = token;
  if (t.length > 4) t = t.replace(/ies$/, "y");
  if (t.length > 5) t = t.replace(/(ing|ed|es|s)$/, "");
  else if (t.length > 4) t = t.replace(/s$/, "");
  return t;
}

/** @returns Lowercased, stopword-free, stemmed tokens (5xx codes also emit "5xx"). */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    if (token.length < 3 && !/\d/.test(token)) continue;
    const s = stem(token);
    out.push(s);
    // "502", "503" etc. should also match the 5xx class.
    if (/^5\d\d$/.test(s)) out.push("5xx");
  }
  return out;
}

function termMatches(term: string, docToken: string): boolean {
  if (term === docToken) return true;
  const shorter = Math.min(term.length, docToken.length);
  return shorter >= 4 && (term.startsWith(docToken) || docToken.startsWith(term));
}

function bestWeight(term: string, fields: Array<{ tokens: string[]; weight: number }>): number {
  let best = 0;
  for (const field of fields) {
    if (field.weight <= best) continue;
    if (field.tokens.some((token) => termMatches(term, token))) best = field.weight;
  }
  return best;
}

/**
 * Deterministic keyword retrieval over the runbooks.
 * @param query Free text (incident description or chat turns).
 * @param runbooks Corpus to search; defaults to the bundled runbooks.
 * @param limit Maximum matches returned.
 * @returns Matches scoring at least MIN_SCORE, best first (ties broken by id).
 */
export function searchRunbooks(query: string, runbooks: Runbook[] = RUNBOOKS, limit = 3): RunbookMatch[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  return runbooks
    .map((runbook) => {
      const fields = [
        { tokens: tokenize(runbook.title), weight: W_TITLE },
        { tokens: tokenize(runbook.symptoms.join(" ")), weight: W_SYMPTOM },
        { tokens: tokenize(runbook.service), weight: W_SERVICE },
        { tokens: tokenize(runbook.checks.join(" ")), weight: W_CHECK },
        { tokens: tokenize(runbook.safeActions.join(" ")), weight: W_ACTION },
        { tokens: tokenize(runbook.escalation), weight: W_ESCALATION },
      ];
      let score = 0;
      const matchedTerms: string[] = [];
      for (const term of terms) {
        const weight = bestWeight(term, fields);
        if (weight > 0) {
          score += weight;
          matchedTerms.push(term);
        }
      }
      return { runbook, score, matchedTerms };
    })
    .filter((match) => match.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.runbook.id.localeCompare(b.runbook.id))
    .slice(0, limit);
}
