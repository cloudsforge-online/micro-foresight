/**
 * THE SEED BATCH, CHECKED AGAINST THE RULES THIS SERVICE ENFORCES ON THE WIRE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `seed/questions-2026h2.mjs` is research, and research is prose until something checks it. Every
 * field in one of those entries is validated by `createDraft` and by `server.ts`'s body parsing —
 * a bad category is a 400 `bad_category`, a source kind the category does not permit is a 400
 * `bad_source_kind`, a close time in the past is a 400 `bad_close_time`, a fee above 1,000bps is a
 * 400 `bad_fee`, a dispute window above 30 days is a `BadRequestError`. Without this file every one
 * of those is discovered by an operator, mid-run, against a live estate, with some markets already
 * created and some not — which is the worst possible place to find a typo, because the seeder is
 * check-then-create and a partial batch has to be reasoned about by hand.
 *
 * So the assertions below are not a restatement of the data. They are the SAME predicates the
 * service applies, run against the data at build time: `isCategory` and `isSourceKindFor` are
 * imported from `categories.ts` rather than re-listed, and the numeric bounds are written as the
 * literals `server.ts` uses with a comment naming the line. When the allowlist changes, this file
 * fails for the questions the change invalidates.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What is deliberately NOT checked here
 *
 * **Whether a question is one the platform should run.** `categories.ts` argues at length that the
 * refusals must not be implemented as a text filter — "a regular expression that looks for the word
 * 'die' would pass 'will X still be with us in June' and would fail a market about a protocol being
 * deprecated" — and that the enforcement is the three-category allowlist plus a person approving.
 * A scan here for the shape of a personal name would be exactly the filter that file refuses, and
 * it would be worse than useless: it would read as a check, so the approver would trust it.
 *
 * **Whether a threshold is well chosen.** `observed` records the reading that justified it, and
 * this file checks that the reading is THERE and dated. Whether 8,000 was the right number for the
 * S&P 500 is a judgement, and a judgement is what the approval queue is for.
 *
 * **Whether the batch duplicates the estate's opening nine.** Those live in `micro-deploy` and this
 * repository does not depend on it. Copying the nine question texts here to diff against would
 * create a second copy that drifts, and a stale copy that reports "no duplicates" is worse than no
 * check. That comparison was done by hand when the batch was written and the three candidates it
 * eliminated are named in the data file's header, which is where a reviewer will look.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_VERSION, isCategory, isSourceKindFor } from './categories.ts'
import { questionHash, type QuestionDocument } from './questiondoc.ts'
import { FORESIGHT_QUESTIONS_2026H2 as BATCH } from '../seed/questions-2026h2.mjs'

/** `server.ts`: `requireInteger(body, 'disputeWindowSeconds', 0, 30 * 86_400)`. */
const MAX_DISPUTE_WINDOW_SECONDS = 30 * 86_400
/** `markets.ts` `createDraft`: `feeBps < 0 || feeBps > 1_000` → 400 `bad_fee`. */
const MAX_FEE_BPS = 1_000

/** The day every reading in the batch was taken. Asserted, so a copied entry cannot smuggle in an old one. */
const RESEARCHED_ON = Date.UTC(2026, 7, 11)

test('the batch is a non-empty list of distinct questions', () => {
  assert.ok(BATCH.length > 0, 'the batch is empty — the import resolved to the wrong module')
  const questions = new Set(BATCH.map((q) => q.question))
  assert.equal(questions.size, BATCH.length, 'two entries carry the same question text')
})

test('every category and source kind is one the allowlist permits', () => {
  for (const q of BATCH) {
    assert.ok(isCategory(q.category), `${q.question} — ${q.category} is not an allowed category`)
    assert.ok(
      isSourceKindFor(q.category, q.resolutionSourceKind),
      `${q.question} — \`${q.resolutionSourceKind}\` is not a source kind \`${q.category}\` may be ` +
        `settled from. \`createDraft\` returns 400 bad_source_kind for this, so the seeding run ` +
        `would fail on this entry and succeed on the ones before it.`,
    )
  }
})

test('every close time is a canonical UTC instant, after the day the batch was researched', () => {
  for (const q of BATCH) {
    const at = new Date(q.closeTime)
    assert.ok(!Number.isNaN(at.getTime()), `${q.question} — closeTime is not a date`)
    assert.equal(
      at.toISOString(),
      q.closeTime,
      `${q.question} — closeTime must be written exactly as \`toISOString()\` produces it, so that ` +
        `what a reviewer reads and what is hashed into questionHash are the same string`,
    )
    assert.ok(
      at.getTime() > RESEARCHED_ON,
      `${q.question} — closeTime is on or before the day the batch was researched`,
    )
  }
})

/**
 * **THE STALENESS TRIPWIRE, AND IT IS MEANT TO GO OFF.**
 *
 * `createDraft` refuses a close time in the past. A question whose close has gone by cannot be
 * seeded at all, so an expired batch is not merely untidy — it is a file that will fail the moment
 * anybody tries to use it, silently, per entry. This asserts that the batch as a WHOLE still has
 * something in it, rather than that every entry does: individual questions expiring is the normal
 * course of a market, and failing the build for that would train everybody to ignore this file.
 *
 * When the last one goes, the build goes red and the message says what to do about it. That is the
 * correct time to find out that the seed data is dead, rather than during a bootstrap.
 */
test('the batch has not expired in its entirety', () => {
  const now = Date.now()
  const live = BATCH.filter((q) => new Date(q.closeTime).getTime() > now)
  assert.ok(
    live.length > 0,
    'every question in seed/questions-2026h2.mjs has closed. `createDraft` returns 400 ' +
      'bad_close_time for all of them, so this file can no longer seed anything. Research a new ' +
      'batch or delete it — do not relax this test.',
  )
})

test('every numeric field is inside the bounds the routes enforce', () => {
  for (const q of BATCH) {
    assert.ok(
      Number.isInteger(q.disputeWindowSeconds) &&
        q.disputeWindowSeconds >= 0 &&
        q.disputeWindowSeconds <= MAX_DISPUTE_WINDOW_SECONDS,
      `${q.question} — disputeWindowSeconds must be a whole number in 0…${MAX_DISPUTE_WINDOW_SECONDS}`,
    )
    assert.ok(
      Number.isInteger(q.feeBps) && q.feeBps >= 0 && q.feeBps <= MAX_FEE_BPS,
      `${q.question} — feeBps must be a whole number in 0…${MAX_FEE_BPS}`,
    )
  }
})

test('every question states what NO means and names a source a reader can open', () => {
  for (const q of BATCH) {
    assert.ok(q.question.trim().endsWith('?'), `${q.question} — is not phrased as a question`)
    assert.match(
      q.resolutionCriteria,
      /\bYES\b/,
      `${q.question} — the criteria never say what makes it YES`,
    )
    assert.match(
      q.resolutionCriteria,
      /\bNO\b/,
      `${q.question} — the criteria never say what makes it NO. An unstated NO is the ambiguity ` +
        `that gets discovered by the first person who loses money on it.`,
    )
    assert.match(
      q.resolutionSourceRef,
      /https:\/\/\S/,
      `${q.question} — resolutionSourceRef must name something a bettor can open before staking; ` +
        `it is hashed into questionHash and cannot be changed after the market is deployed`,
    )
    assert.ok(q.cover.trim().length > 0, `${q.question} — has no cover prompt`)
  }
})

test('every question carries a dated reading that justifies its threshold', () => {
  for (const q of BATCH) {
    assert.match(
      q.observed,
      // No trailing `\b`: a reading timestamped `2026-08-11T14:15Z` is a date, and `T` is a word
      // character, so a closing boundary would reject the most precise entries in the file.
      /\b20\d\d-\d\d-\d\d/,
      `${q.question} — \`observed\` must record WHEN the reading was taken. "Above 8,000" means ` +
        `nothing without "7,760 on the day", and an approver cannot tell a market that was ` +
        `uncertain at open from one that was already decided.`,
    )
  }
})

/**
 * Distinct documents, hashed the way the contract will hash them.
 *
 * `questionHash` covers `closeTime` as well as the text, so this is a strictly weaker check than
 * the distinct-question-text one above — two markets on the same question at different closes are
 * legitimate and hash differently. It is here because it exercises the real codec against the real
 * data: a field that is a `number` where the document wants one, and a `closeTime` that converts to
 * whole unix seconds rather than to a fraction.
 */
test('every entry produces a distinct question hash under the current allowlist version', () => {
  const hashes = new Set<string>()
  for (const q of BATCH) {
    const closeTime = new Date(q.closeTime).getTime() / 1000
    assert.ok(
      Number.isInteger(closeTime),
      `${q.question} — closeTime has sub-second precision; the document stores unix SECONDS`,
    )
    const doc: QuestionDocument = {
      question: q.question,
      resolutionCriteria: q.resolutionCriteria,
      category: q.category,
      categoryVersion: CATEGORY_VERSION,
      resolutionSourceKind: q.resolutionSourceKind,
      resolutionSourceRef: q.resolutionSourceRef,
      closeTime,
      disputeWindowSeconds: q.disputeWindowSeconds,
      feeBps: q.feeBps,
    }
    const hash = questionHash(doc)
    assert.ok(!hashes.has(hash), `${q.question} — two entries hash to ${hash}`)
    hashes.add(hash)
  }
})

/**
 * A spread, checked loosely.
 *
 * Not an aesthetic preference: a batch that is eleven price questions gives a browse page eleven
 * rows of the same idea, and the first thing a stranger learns about the product is that it is for
 * people who already trade. The assertion is only that no category is empty and that none of them
 * takes the whole batch — the point at which "a spread" stops being true.
 */
test('the batch spans every category without being dominated by one', () => {
  const counts = new Map<string, number>()
  for (const q of BATCH) counts.set(q.category, (counts.get(q.category) ?? 0) + 1)
  for (const category of ['protocol_network', 'market_prices', 'scheduled_public_events']) {
    const n = counts.get(category) ?? 0
    assert.ok(n > 0, `no question in the batch is a ${category} question`)
    assert.ok(
      n < BATCH.length,
      `every question in the batch is a ${category} question — that is one idea, not a market page`,
    )
  }
})
