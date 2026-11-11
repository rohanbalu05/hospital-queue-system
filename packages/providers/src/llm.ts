import { NotConfiguredError } from './errors.js';
import type { ProviderEnv } from './storage.js';

/** A clinician-verified instruction version. Only verified, current-patient versions are ever passed in. */
export interface LlmContextItem {
  instructionVersionId: string;
  title: string;
  version: number;
  body: string;
}

export type LlmUnsupportedCode = 'denied_intent' | 'no_context' | 'no_match' | 'too_long';

export type LlmAnswer =
  | { kind: 'answer'; text: string; citedVersionIds: string[] }
  | { kind: 'unsupported'; reason: string; code?: LlmUnsupportedCode };

/**
 * Bounded patient assistant (FR-14). It may restate what a verified instruction says and cite the version.
 * It never diagnoses, changes treatment, or touches queue priority. `unsupported` means: create an owned
 * staff task instead of answering.
 */
export interface LlmProvider {
  readonly name: string;
  answer(input: { question: string; context: LlmContextItem[] }, opts?: { signal?: AbortSignal }): Promise<LlmAnswer>;
}

export const DEFAULT_LLM_MODEL = 'gemini-3.5-flash-lite';
const MAX_QUESTION_CHARS = 2000;

/**
 * Building blocks for treatment-change phrasings that name the medicine directly ("Should I stop metformin?")
 * and so need no generic noun such as "medicine" or "dose". The patterns carry the intent in the verb and the
 * modal/intent frame; they never look at the medicine name (so any drug, or none, is covered).
 */
const STOP_VERBS =
  "(?:stop(?:ping)?|quit(?:ting)?|discontinu(?:e|ing)|ceas(?:e|ing)|skip(?:ping)?|come off|coming off|go off|going off|taper(?:ing)?(?: off)?|give up|giving up)";
const DOSE_VERBS =
  "(?:cut(?:ting)? (?:down|back)(?: on)?|reduc(?:e|ing)|lower(?:ing)?|decreas(?:e|ing)|increas(?:e|ing)|rais(?:e|ing)|doubl(?:e|ing)|halv(?:e|ing)|tripl(?:e|ing))";
/** "should I", "can I", "shouldn't I", "do I still need to" ... followed by the verb. */
const modal = (verbs: string): RegExp =>
  new RegExp(`\\b(?:should|shall|can|could|may|might|must|do|would)(?:n't)? i (?:just |still |now |also )?(?:need to |have to )?${verbs}\\b`);
/** "is it ok to ...", "would it be safe for me to ..." */
const approval = (verbs: string): RegExp =>
  new RegExp(`\\b(?:is it|would it be|is it going to be) (?:ok|okay|fine|safe|alright|all right|acceptable|allowed|better|best)(?: for me)? to ${verbs}\\b`);
/** "I want to ...", "I'd like to ...", "I am going to ...", "I plan to ..." */
const wantTo = (verbs: string): RegExp =>
  new RegExp(
    `\\bi(?:'d| would)? (?:want|like|wish|plan|intend|need|decided|have decided)(?: to)? ${verbs}\\b|\\bi(?: am|'m) (?:going|planning|thinking|trying|about|ready|deciding)(?: to| of| about)? ${verbs}\\b`,
  );

/**
 * Intents the assistant refuses whatever the context says (FR-14: no diagnosis, no treatment change,
 * no priority). Matched on the patient's question only; context text is never consulted for this.
 */
const DENIED_INTENTS: ReadonlyArray<{ intent: string; patterns: RegExp[] }> = [
  {
    intent: 'a diagnosis',
    patterns: [
      /\bdiagnos(e|es|ed|is|ing)\b/,
      /\bwhat('s| is) wrong with me\b/,
      /\bwhat (disease|illness|condition|infection|problem) do i have\b/,
      /\bdo i have (a |an )?(\w+ ){0,2}(cancer|diabetes|infection|disease|tumou?r|covid|dengue|malaria|tb|tuberculosis|condition)\b/,
      /\bis (it|this|that) (cancer|serious|dangerous|life.threatening)\b/,
    ],
  },
  {
    intent: 'a change of dose',
    patterns: [
      /\b(increase|decrease|double|halve|reduce|raise|lower|adjust|change|alter)\b[^.?!]{0,40}\b(dose|dosage|dosing)\b/,
      /\b(dose|dosage)\b[^.?!]{0,30}\b(increase|decrease|double|change|higher|lower|bigger|smaller)\b/,
      /\btake (more|less|double|extra|half)\b/,
      /\bdouble up\b/,
      modal(DOSE_VERBS),
      approval(DOSE_VERBS),
      wantTo(DOSE_VERBS),
      // "take it only once a day instead of twice", "only half a tablet"
      /\b(?:once|twice|thrice|\d+ times?|one time|two times|three times) (?:a|per|each|every) (?:day|week|night)\b[^.?!]{0,20}\binstead\b/,
      /\b(?:take|use|have)\b[^.?!]{0,40}\bonly (?:once|twice|thrice|one|two|three|half|a half|every other)\b/,
    ],
  },
  {
    intent: 'stopping a medicine',
    patterns: [
      /\b(stop|stopping|quit|discontinue|cease|give up)\b[^.?!]{0,30}\b(taking|medicine|medicines|medication|medications|tablet|tablets|pill|pills|antibiotic|antibiotics|treatment|course|injection)\b/,
      /\bcan i (just )?stop\b/,
      /\bno longer (need|take)\b/,
      modal(STOP_VERBS),
      approval(STOP_VERBS),
      wantTo(STOP_VERBS),
      // "do I still need to take X", "do I need to keep taking X"
      /\bdo i still (?:need|have) to (?:take|use)\b/,
      /\bdo i (?:still )?(?:need|have) to (?:keep|continue) (?:taking|using|take|use)\b/,
    ],
  },
  {
    intent: 'a new or different medicine',
    patterns: [
      /\b(new|another|different|alternative|extra|additional)\b[^.?!]{0,20}\b(medicine|medicines|medication|drug|drugs|tablet|tablets|pill|antibiotic|painkiller|supplement|remedy)\b/,
      /\b(also take|can i add|add (a|an|another)|combine|mix (it )?with|along with|in addition to|instead of|switch to|replace)\b/,
      /\b(?:switch|switching|swap|swapping)(?: over)? from\b/,
      /\b(can|may|should) i (also )?(take|use|try) (ibuprofen|aspirin|antibiotics?|painkillers?|herbal|ayurvedic|homeopathic|alcohol|steroids?)\b/,
    ],
  },
  {
    intent: 'booking or cancelling an appointment',
    patterns: [
      /\b(book|rebook|reschedul(e|ing)|cancel(l?ing)?|postpone|prepone|re-?arrange)\b[^.?!]{0,40}\b(appointment|appointments|visit|slot|consultation|booking|session|token|me)\b/,
      /\b(make|schedule|arrange|get|fix|set up|need|want) (me )?(an? |another |my )?(new )?(appointment|booking|slot)\b/,
      /\b(book|cancel)\b[^.?!]{0,20}\b(me|my)\b/,
      /\bmove (my|the) (appointment|visit|slot|booking)\b/,
    ],
  },
  {
    intent: 'queue priority or urgency',
    patterns: [
      /\b(priority|prioriti[sz]e|urgent|urgency|emergency|triage|jump the queue|skip the queue|cut the queue|move me up|move up the queue|front of the queue)\b/,
      /\b(see|seen|meet) (the )?(doctor )?(first|sooner|earlier|before)\b/,
      /\bam i (urgent|serious|critical|an emergency)\b/,
    ],
  },
];

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its may me my of on or our should so than that the their them then there these they this to us was we were what when where which who why will with would you your about after before also not any some very just get got take takes taking took use using often long many much need tell know please want time times day days one ones two three give gives gave giving new make makes made let lets go goes going come comes say said see look like other another same more less only own still well yes no ok okay thing things way back out up down off over again here now today tomorrow next first last each every either both few other another`.split(
    /\s+/,
  ),
);

/** Lowercase word stem good enough to match tablet/tablets and take/taking/takes. */
function stem(raw: string): string {
  let w = raw;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Content words of a text as a stemmed set. Pure string work: the text is data, never interpreted. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    out.add(stem(t));
  }
  return out;
}

function sentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The provider-independent deny-list (FR-14): the intent the question asks for that the assistant must never
 * handle (diagnosis, dose change, stopping or starting a medicine, priority or urgency, booking or cancelling),
 * or null. Pure; the API runs it BEFORE any provider call so a different or compromised provider cannot widen
 * what the assistant answers.
 */
export function deniedIntent(question: string): string | null {
  const q = question.toLowerCase().replace(/[‘’]/g, "'");
  for (const d of DENIED_INTENTS) if (d.patterns.some((p) => p.test(q))) return d.intent;
  return null;
}

/**
 * Deterministic templated assistant. It answers only by quoting sentences of the supplied verified
 * instruction versions that share keywords with the question, and cites those version ids.
 * Context text is treated as data: it is tokenised and quoted, never followed ("ignore previous
 * instructions" in an instruction body changes nothing), and the deny-list looks at the question only.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';

  answer(input: { question: string; context: LlmContextItem[] }): Promise<LlmAnswer> {
    return Promise.resolve(this.run(input));
  }

  private run({ question, context }: { question: string; context: LlmContextItem[] }): LlmAnswer {
    if (question.length > MAX_QUESTION_CHARS) {
      return {
        kind: 'unsupported',
        reason: 'The question is too long for the assistant; staff will follow up.',
        code: 'too_long',
      };
    }
    const denied = deniedIntent(question);
    if (denied) {
      return {
        kind: 'unsupported',
        reason: `The assistant cannot help with ${denied}; a staff member will follow up with you.`,
        code: 'denied_intent',
      };
    }
    const usable = context.filter((c) => c.body.trim().length > 0);
    if (usable.length === 0) {
      return {
        kind: 'unsupported',
        reason: 'No verified instruction is available for this question; staff will follow up.',
        code: 'no_context',
      };
    }

    const qWords = keywords(question);
    interface Hit {
      item: LlmContextItem;
      score: number;
      quotes: string[];
    }
    const hits: Hit[] = [];
    for (const item of usable) {
      const matched = new Set<string>();
      const ranked = sentences(item.body).map((s, index) => {
        const sw = keywords(s);
        const shared = [...qWords].filter((w) => sw.has(w));
        shared.forEach((w) => matched.add(w));
        return { s, index, n: shared.length };
      });
      const best = ranked
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n || a.index - b.index)
        .slice(0, 3)
        .sort((a, b) => a.index - b.index);
      if (best.length > 0) hits.push({ item, score: matched.size, quotes: best.map((b) => b.s) });
    }
    if (hits.length === 0) {
      return {
        kind: 'unsupported',
        reason: 'Your verified instructions do not cover this question; staff will follow up.',
        code: 'no_match',
      };
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        b.item.version - a.item.version ||
        a.item.instructionVersionId.localeCompare(b.item.instructionVersionId),
    );
    const top = hits.slice(0, 2);
    const text = top
      .map(
        (h) =>
          `Your verified instruction "${h.item.title}" (version ${h.item.version}) says: ${h.quotes.map((q) => `"${q}"`).join(' ')}`,
      )
      .join('\n');
    return { kind: 'answer', text, citedVersionIds: top.map((h) => h.item.instructionVersionId) };
  }
}

/** Gemini adapter: later. Model id from config. Never called by default. */
export class GeminiLlmProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly model: string;
  constructor(readonly opts: { apiKey?: string; model?: string } = {}) {
    this.model = opts.model || DEFAULT_LLM_MODEL;
  }

  answer(): Promise<LlmAnswer> {
    return Promise.reject(
      new NotConfiguredError(
        'gemini',
        this.opts.apiKey ? `adapter not implemented in this build (model ${this.model})` : 'GEMINI_API_KEY is not set',
      ),
    );
  }
}

export function createLlmProvider(env: ProviderEnv = process.env): LlmProvider {
  const kind = env['LLM_PROVIDER'] || 'fake';
  switch (kind) {
    case 'fake':
      return new FakeLlmProvider();
    case 'gemini':
      return new GeminiLlmProvider({ apiKey: env['GEMINI_API_KEY'], model: env['LLM_MODEL'] || DEFAULT_LLM_MODEL });
    default:
      throw new Error(`LLM_PROVIDER must be fake or gemini (got "${kind}")`);
  }
}
