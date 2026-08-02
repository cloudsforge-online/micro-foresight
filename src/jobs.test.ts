/**
 * The leased jobs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **TWO WORKERS, ONE DUE JOB → ONE RUN.**
 *
 * This is the property rule 8 of docs/ecosystem/03 §2 exists for, and it is the reason there is no
 * `setInterval` anywhere in this repository. A timer is a variable in one process and is by
 * construction invisible to a second: two replicas both fire, both do the work, and for the idea
 * pipeline that means a doubled operator queue and a doubled model bill.
 *
 * The test below runs two REAL `JobRunner`s against one REAL Postgres and counts. `FOR UPDATE SKIP
 * LOCKED` in `@cloudsforge/jobs` is what makes the second one see nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import {
  FEE_REPORT,
  IDEA_PROPOSE,
  JOB_KINDS,
  MARKET_CLOSE,
  MARKET_DEPLOY,
  MIRROR_SYNC,
  OUTBOX_RELAY,
  PROPOSAL_TOPICS,
  RESOLUTION_POST,
  applyConfirmedResolution,
  deploySweepHandler,
  feeReportHandler,
  ideaProposeHandler,
  marketCloseHandler,
  seedRecurring,
  type JobDeps,
} from './jobs.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { findMarket } from './markets.ts'
import { ACTION_VOID } from './resolve.ts'
import { feeIdempotencyKey, type EntryRequest, type LedgerClient } from './ledgerclient.ts'
import {
  db,
  enabled,
  fakeIndexer,
  fakeProposer,
  migrateTestDb,
  openDb,
  openDirect,
  quietLogger,
  resetForesight,
  seedDraft,
  skip,
  testMetrics,
  FUTURE,
} from './testsupport.ts'

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

function ledgerRecording(posted: EntryRequest[]): LedgerClient {
  return {
    async postEntry(request) {
      posted.push(request)
      return { id: `entry-${posted.length}`, kind: request.kind, recordedAt: new Date().toISOString(), replayed: false }
    },
  }
}

function depsFor(queue: JobQueue, overrides: Partial<JobDeps> = {}): JobDeps {
  return {
    sql: db(sql),
    queue,
    producer: 'foresight',
    network: 'testnet',
    chain: 'ember',
    logger: quietLogger(),
    metrics: testMetrics(),
    proposer: fakeProposer({ proposals: [], reason: 'not_configured', searchQuery: null, modelId: null }, false),
    proposalBatchSize: 3,
    proposeEveryMinutes: 360,
    deploy: {} as JobDeps['deploy'],
    resolve: {} as JobDeps['resolve'],
    mirror: { sql: db(sql), indexer: fakeIndexer(), pageSize: 10, logger: quietLogger(), metrics: testMetrics() },
    ledger: ledgerRecording([]),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ the lease */

test('THE PROPERTY: two workers, one due idea job, exactly one run', { skip }, async () => {
  const jobs = sql as unknown as JobsSql
  const queueA = new JobQueue(jobs, { owner: 'worker-a', leaseMs: 60_000 })
  const queueB = new JobQueue(jobs, { owner: 'worker-b', leaseMs: 60_000 })

  let runs = 0
  const proposer = fakeProposer({
    proposals: [
      {
        question: 'Will Hearth mainnet reach block height 5,000,000 before 2027-01-01T00:00:00Z?',
        resolutionCriteria: 'YES if the named explorer shows that block before the instant given.',
        category: 'protocol_network',
        categoryVersion: CATEGORY_VERSION,
        resolutionSourceKind: 'block_explorer',
        resolutionSourceRef: 'https://explorer.cloudsforge.online/#/block/5000000',
        suggestedCloseTime: FUTURE(),
        origin: 'model',
        searchQuery: 'q',
        sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: new Date().toISOString() }],
        modelId: 'm',
        promptSha256: 'a'.repeat(64),
      },
    ],
    reason: 'ok',
    searchQuery: 'q',
    modelId: 'm',
  })

  const handler = ideaProposeHandler(depsFor(queueA, { proposer }))
  const counting = async (...args: Parameters<typeof handler>) => {
    runs += 1
    await handler(...args)
  }

  const runnerA = new JobRunner({ queue: queueA, concurrency: 2, pollMs: 10 })
  const runnerB = new JobRunner({ queue: queueB, concurrency: 2, pollMs: 10 })
  runnerA.register(IDEA_PROPOSE, counting)
  runnerB.register(IDEA_PROPOSE, counting)

  await queueA.enqueue({ kind: IDEA_PROPOSE, key: 'global' })

  // Both workers tick at the same time against one row. `FOR UPDATE SKIP LOCKED` means the loser
  // sees nothing rather than waiting for it, so the two never serialise and never share the row.
  const [claimedA, claimedB] = await Promise.all([runnerA.tick(), runnerB.tick()])
  assert.equal(claimedA + claimedB, 1, `both workers claimed the job (${claimedA} + ${claimedB})`)
  assert.equal(runs, 1, 'the handler ran more than once for one due job')

  // And the pipeline stored exactly ONE RUN's worth — one proposal per searched topic. A second
  // run would double this, which is the damage the lease exists to prevent.
  const ideas = await sql<{ n: number }[]>`select count(*)::int as n from ideas`
  assert.equal(ideas[0]?.n, PROPOSAL_TOPICS.length, 'the pipeline ran more than once')
})

test('a recurring job re-enqueues itself rather than living on a timer', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const handler = ideaProposeHandler(depsFor(queue))
  await handler({ id: 'x', kind: IDEA_PROPOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  const rows = await sql<{ kind: string; run_at: Date }[]>`select kind, run_at from jobs where kind = ${IDEA_PROPOSE}`
  assert.equal(rows.length, 1)
  assert.ok((rows[0]?.run_at.getTime() ?? 0) > Date.now(), 'the next run was not scheduled in the future')
})

test('an unconfigured proposer completes the run and schedules the next one', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  // Not a throw, not a dead letter, and not an error line every six hours for a thing nobody has
  // set up. `micro-notify`'s SMTP discipline.
  const handler = ideaProposeHandler(depsFor(queue))
  await handler({ id: 'x', kind: IDEA_PROPOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  assert.equal((await sql`select 1 from ideas`).length, 0)
  assert.equal((await sql`select 1 from jobs where kind = ${IDEA_PROPOSE}`).length, 1)
})

test('a proposal that fails validation is dropped and counted, never repaired', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const metrics = testMetrics()
  const proposer = fakeProposer({
    proposals: [
      {
        // A category outside the allowlist — the shape a model that drifted would produce.
        question: 'Will a named person do a thing?',
        resolutionCriteria: 'YES if it is reported somewhere plausible.',
        category: 'celebrity_gossip',
        categoryVersion: CATEGORY_VERSION,
        resolutionSourceKind: 'block_explorer',
        resolutionSourceRef: 'https://example.invalid/x',
        suggestedCloseTime: FUTURE(),
        origin: 'model',
        searchQuery: 'q',
        sources: [{ url: 'https://example.invalid/a', title: 'A', retrievedAt: new Date().toISOString() }],
        modelId: 'm',
        promptSha256: 'a'.repeat(64),
      },
    ],
    reason: 'ok',
    searchQuery: 'q',
    modelId: 'm',
  })
  const handler = ideaProposeHandler(depsFor(queue, { proposer, metrics }))
  await handler({ id: 'x', kind: IDEA_PROPOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  assert.equal((await sql`select 1 from ideas`).length, 0, 'a proposal outside the allowlist was stored')
  assert.match(metrics.render(), /foresight_proposals_dropped_total\{reason="bad_category"\} 3/)
})

/* ------------------------------------------------------------------ closing */

test('the close job closes only what is due, and re-enqueues itself', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const due = await seedDraft(sql, { closeTime: new Date(Date.now() + 60_000) })
  const notDue = await seedDraft(sql, { closeTime: new Date(Date.now() + 10 * 60_000) })
  await openDirect(sql, due.id)
  await openDirect(sql, notDue.id)

  const now = new Date(Date.now() + 2 * 60_000)
  const handler = marketCloseHandler(depsFor(queue, { now: () => now }))
  await handler({ id: 'x', kind: MARKET_CLOSE, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })

  assert.equal((await findMarket(db(sql), due.id))?.status, 'closed')
  assert.equal((await findMarket(db(sql), notDue.id))?.status, 'open')
  // One event, on the public topic.
  const events = await sql<{ topic: string }[]>`select topic from outbox`
  assert.deepEqual(events.map((row) => row.topic), ['foresight.market.closed'])
  assert.equal((await sql`select 1 from jobs where kind = ${MARKET_CLOSE}`).length, 1)
})

/* ------------------------------------------------------------------ the sweep */

test('the sweep re-enqueues every outstanding deploy, so a closed tab strands nothing', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const a = await seedDraft(sql)
  const b = await seedDraft(sql)
  await sql`update markets set status = 'approved', approved_by = ${'operator:x'}, approved_at = now() where id in (${a.id}, ${b.id})`

  const handler = deploySweepHandler(depsFor(queue))
  await handler({ id: 'x', kind: MARKET_DEPLOY, key: 'sweep', attempts: 1, maxAttempts: 5, payload: {} }, {
    heartbeat: async () => true,
    signal: new AbortController().signal,
  })
  const queued = await sql<{ key: string }[]>`select key from jobs where kind = ${MARKET_DEPLOY} order by key`
  assert.deepEqual(queued.map((row) => row.key).sort(), [a.id, b.id].sort())
})

/* ------------------------------------------------------------------ the fee report */

test('a fee is reported to the ledger from an indexed event, once', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`
    update markets set status = 'resolved', outcome = 0, closed_at = now(), resolved_at = now()
     where id = ${market.id}
  `
  await sql`
    insert into fee_reports (market_id, amount_wei, treasury, tx_hash, log_index, block_height)
    values (${market.id}, ${(12_345_678_901_234_567_890n).toString()}, ${'0x' + '22'.repeat(20)},
            ${'0x' + '33'.repeat(32)}, 2, 99)
  `

  const posted: EntryRequest[] = []
  const handler = feeReportHandler(depsFor(queue, { ledger: ledgerRecording(posted) }))
  const job = { id: 'x', kind: FEE_REPORT, key: 'global', attempts: 1, maxAttempts: 5, payload: {} }
  const ctx = { heartbeat: async () => true, signal: new AbortController().signal }
  await handler(job, ctx)

  assert.equal(posted.length, 1)
  const entry = posted[0]
  // 'fee_charged' — the ledger's closed journal_entries_kind_chk vocabulary
  // (ledger/src/migrations.ts:181). The previous expectation pinned a kind the ledger refuses,
  // which is a test asserting the defect; corrected with the posting fix in ledgerclient.ts.
  assert.equal(entry?.kind, 'fee_charged')
  // The key is derived from the market id, so a retry replays rather than posting twice.
  assert.equal(entry?.idempotencyKey, feeIdempotencyKey(market.id))
  // A bigint all the way to the wire, and a decimal STRING on it. A JSON number would not survive.
  assert.equal(entry?.postings[0]?.amount, 12_345_678_901_234_567_890n)
  assert.equal(entry?.postings[0]?.direction, 'debit')
  assert.equal(entry?.postings[1]?.direction, 'credit')
  assert.equal(
    entry?.postings.reduce((sum, p) => sum + (p.direction === 'debit' ? p.amount : -p.amount), 0n),
    0n,
    'the entry does not balance',
  )

  // The market is settled, and the report is marked so the next pass does not repost it.
  assert.equal((await findMarket(db(sql), market.id))?.status, 'settled')
  await handler(job, ctx)
  assert.equal(posted.length, 1, 'the fee was reported twice')
})

test('THE CONSTRAINT: one indexed fee event cannot become two reports', { skip }, async () => {
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  const insert = () => sql`
    insert into fee_reports (market_id, amount_wei, treasury, tx_hash, log_index, block_height)
    values (${market.id}, 1, ${'0x' + '22'.repeat(20)}, ${'0x' + '44'.repeat(32)}, 0, 1)
  `
  await insert()
  await assert.rejects(
    insert(),
    (err: unknown) => (err as { constraint_name?: string }).constraint_name === 'fee_reports_source_uniq',
  )
})

/* ------------------------------------------------------------------ applying a confirmed resolution */

test('a confirmed void becomes a voided market with the rationale as the reason', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  const market = await seedDraft(sql)
  await openDirect(sql, market.id)
  await sql`update markets set status = 'closed', closed_at = now() where id = ${market.id}`

  await applyConfirmedResolution(
    depsFor(queue),
    market.id,
    ACTION_VOID,
    'the named resolution source is unreachable at resolution',
  )
  const voided = await findMarket(db(sql), market.id)
  assert.equal(voided?.status, 'void')
  assert.match(voided?.voidReason ?? '', /unreachable at resolution/)
  const events = await sql<{ topic: string }[]>`select topic from outbox`
  assert.deepEqual(events.map((row) => row.topic), ['foresight.market.voided'])
})

/* ------------------------------------------------------------------ the registry */

test('every job kind has a documented lease key, and the recurring ones are seeded once', { skip }, async () => {
  const queue = new JobQueue(sql as unknown as JobsSql, { owner: 'w', leaseMs: 60_000 })
  assert.deepEqual([...JOB_KINDS].sort(), [
    FEE_REPORT,
    IDEA_PROPOSE,
    MARKET_CLOSE,
    MARKET_DEPLOY,
    MIRROR_SYNC,
    OUTBOX_RELAY,
    RESOLUTION_POST,
  ].sort())

  // N replicas booting together produce ONE pending run of each, because `(kind, key)` is unique
  // and `onConflict: 'keep'` collapses the rest.
  await Promise.all([
    seedRecurring(queue, 'ember', 'testnet'),
    seedRecurring(queue, 'ember', 'testnet'),
    seedRecurring(queue, 'ember', 'testnet'),
  ])
  const rows = await sql<{ kind: string; key: string }[]>`select kind, key from jobs order by kind`
  assert.equal(rows.length, 5)
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.key}`).sort(),
    [
      `${FEE_REPORT}:global`,
      `${IDEA_PROPOSE}:global`,
      `${MARKET_CLOSE}:global`,
      `${OUTBOX_RELAY}:global`,
      // The one that is NOT global: the oracle's nonce is contended per chain.
      `${RESOLUTION_POST}:oracle:ember:testnet`,
    ].sort(),
  )
})
