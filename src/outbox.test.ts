/**
 * The outbox: the event and the change commit together, or neither does.
 *
 * Rule 5 of docs/ecosystem/03 §2. A publish after commit is a publish that is skipped when the
 * process dies in between; a publish before commit is a publish of something that never happened.
 * Both failure modes are silent and both are unrecoverable after the fact.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { MARKET_OPENED, TOPICS, signEvent, verifyEventSignature, withInbox, withOutbox } from './outbox.ts'
import { db, enabled, migrateTestDb, openDb, resetForesight, seedDraft, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetForesight(sql)
})

/**
 * The registry's shape rule: `<service>.<aggregate>.<past-tense-verb>`, three lowercase segments.
 *
 * None of these is in `@cloudsforge/contracts-events` `TOPICS` yet — that registry is exact-pinned
 * and adding to it is a coordinated release. Satisfying the shape now means registering them later
 * is an ADDITION and never a rename, which is what stops a subscriber breaking.
 */
test('every topic satisfies the registry’s shape rule', () => {
  // Seven since the header image landed: `foresight.market.imaged` and `foresight.idea.imaged`.
  // The verb is `imaged` rather than `image_set` because the regex below admits no underscore, and
  // a name that could not be registered later would have to be renamed — which is the one change
  // that breaks a subscriber.
  assert.equal(TOPICS.length, 7)
  for (const topic of TOPICS) {
    assert.match(topic, /^[a-z]+\.[a-z]+\.[a-z]+$/, `${topic} is not <service>.<aggregate>.<verb>`)
    assert.ok(topic.startsWith('foresight.'), `${topic} does not name this service`)
  }
  assert.equal(new Set(TOPICS).size, TOPICS.length)
})

test('a rolled-back change publishes nothing', { skip }, async () => {
  const market = await seedDraft(sql)
  await assert.rejects(
    withOutbox(db(sql), 'foresight', async (tx, emit) => {
      await tx`update markets set question = 'changed' where id = ${market.id}`
      emit({ topic: MARKET_OPENED, key: market.id, payload: { id: market.id } })
      // The change and the event are in one transaction; this rolls both back.
      throw new Error('something went wrong after the emit')
    }),
    /something went wrong/,
  )
  assert.equal((await sql`select 1 from outbox`).length, 0, 'an event was published for a change that never happened')
  const rows = await sql<{ question: string }[]>`select question from markets where id = ${market.id}`
  assert.notEqual(rows[0]?.question, 'changed')
})

test('a committed change always has its event, in the same transaction', { skip }, async () => {
  const market = await seedDraft(sql)
  await withOutbox(db(sql), 'foresight', async (tx, emit) => {
    await tx`update markets set question = 'a new question' where id = ${market.id}`
    emit({
      topic: MARKET_OPENED,
      key: market.id,
      payload: { id: market.id },
      actor: 'operator:x',
      correlationId: 'req-1',
    })
  })
  const events = await sql<{ topic: string; key: string; actor: string; correlation_id: string; producer: string }[]>`
    select topic, key, actor, correlation_id, producer from outbox
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.topic, MARKET_OPENED)
  assert.equal(events[0]?.key, market.id)
  assert.equal(events[0]?.actor, 'operator:x')
  assert.equal(events[0]?.producer, 'foresight')
})

test('the signature is over the exact bytes, and verification is timing-safe', () => {
  const body = JSON.stringify({ id: 'e1', topic: MARKET_OPENED })
  const signature = signEvent(body, 'a-secret')
  assert.match(signature, /^sha256=[0-9a-f]{64}$/)
  assert.equal(verifyEventSignature(body, 'a-secret', signature), true)
  assert.equal(verifyEventSignature(body, 'another-secret', signature), false)
  assert.equal(verifyEventSignature(`${body} `, 'a-secret', signature), false)
  // A length mismatch must not throw out of `timingSafeEqual` — a subscriber sending a truncated
  // header would otherwise take the relay down rather than being rejected.
  assert.equal(verifyEventSignature(body, 'a-secret', 'sha256=short'), false)
  assert.equal(verifyEventSignature(body, 'a-secret', ''), false)
})

test('the inbox runs a handler once and swallows the redelivery', { skip }, async () => {
  let runs = 0
  const handler = async () => {
    runs += 1
    return 'done'
  }
  const first = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000010', handler)
  assert.equal(first.status, 'processed')
  const second = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000010', handler)
  assert.equal(second.status, 'duplicate')
  assert.equal(runs, 1)
})

test('a handler that fails leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  // The mistake that makes a naive "record then handle" dedupe LOSE events: the insert and the
  // handler share one transaction, so a failure rolls the claim back too.
  await assert.rejects(
    withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000011', async () => {
      throw new Error('handler blew up')
    }),
    /handler blew up/,
  )
  assert.equal((await sql`select 1 from inbox`).length, 0)

  let runs = 0
  const outcome = await withInbox(db(sql), 'some.topic', '00000000-0000-4000-8000-000000000011', async () => {
    runs += 1
    return 'ok'
  })
  assert.equal(outcome.status, 'processed')
  assert.equal(runs, 1)
})
