/**
 * Every piece of background work this service does, and the key each one is leased on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.** `@cloudsforge/jobs`'s own header
 * says it and it is the thing most likely to be got wrong by someone adding a job here.
 *
 *   | Work              | Key                        | Why                                       |
 *   |-------------------|----------------------------|-------------------------------------------|
 *   | idea.propose      | global                     | One pipeline run per period. Two would    |
 *   |                   |                            | double the operator's queue and double    |
 *   |                   |                            | the model bill.                           |
 *   | market.deploy     | market id                  | Genuinely parallel: every market has its  |
 *   |                   |                            | OWN custody deployer address, so no two   |
 *   |                   |                            | deploys share a nonce. The row IS the     |
 *   |                   |                            | resource.                                 |
 *   | resolution.post   | oracle:chain:network       | **The opposite case.** Every market on a  |
 *   |                   |                            | chain resolves through ONE oracle address,|
 *   |                   |                            | so the contended resource is that         |
 *   |                   |                            | address's nonce. Keying on the market     |
 *   |                   |                            | would let two resolutions sign against one|
 *   |                   |                            | nonce and lose one of them permanently.   |
 *   | market.close      | global                     | A scan, not a row. Two scanners would do  |
 *   |                   |                            | the same work twice for nothing.          |
 *   | mirror.sync       | market id                  | Parallel; one market's chain reads do not |
 *   |                   |                            | contend with another's.                   |
 *   | fee.report        | global                     | One posting pass; the ledger's own key    |
 *   |                   |                            | makes a duplicate a replay, but a second  |
 *   |                   |                            | worker is still wasted round trips.       |
 *   | outbox.relay      | global                     | Two relays deliver every event twice.     |
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **There is no `setInterval` in this repository.** Recurrence is a job that re-enqueues itself
 * with a future `runAt`, which is the only form that is correct with two replicas: a timer is a
 * variable in one process and is by construction invisible to the other.
 */

import { JobQueue, type Handler } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Network } from '@cloudsforge/contracts-chain'
import { CATEGORY_VERSION } from './categories.ts'
import { chainKey, type ChainId } from './chains.ts'
import { driveDeploy, listOutstandingDeploys, type DeployDeps } from './deploy.ts'
import { insertIdea, IdeaError } from './ideas.ts'
import { feeIdempotencyKey, feePostings, LedgerUnavailableError, type LedgerClient } from './ledgerclient.ts'
import { closeMarket, listDueToClose, markResolved, markSettled, voidMarket } from './markets.ts'
import { recordSyncError, syncMarket, type MirrorDeps } from './mirror.ts'
import { withOutbox, type Db } from './outbox.ts'
import type { Proposer } from './proposer.ts'
import {
  ACTION_VOID,
  driveResolution,
  listOutstandingResolutions,
  resolutionLeaseKey,
  type ResolveDeps,
} from './resolve.ts'

export const IDEA_PROPOSE = 'idea.propose'
export const MARKET_DEPLOY = 'market.deploy'
export const MARKET_CLOSE = 'market.close'
export const MIRROR_SYNC = 'mirror.sync'
export const RESOLUTION_POST = 'resolution.post'
export const FEE_REPORT = 'fee.report'
export const OUTBOX_RELAY = 'outbox.relay'

export const JOB_KINDS: readonly string[] = Object.freeze([
  IDEA_PROPOSE,
  MARKET_DEPLOY,
  MARKET_CLOSE,
  MIRROR_SYNC,
  RESOLUTION_POST,
  FEE_REPORT,
  OUTBOX_RELAY,
])

/** The topics the idea pipeline searches. Configuration would be nicer; a constant is honest. */
export const PROPOSAL_TOPICS: readonly string[] = Object.freeze([
  'blockchain protocol upgrades and network milestones scheduled in the coming months',
  'publicly scheduled software and hardware releases with announced dates',
  'published cryptocurrency and commodity price levels from named exchanges',
])

export interface JobDeps {
  readonly sql: Db
  readonly queue: JobQueue
  readonly producer: string
  readonly network: Network
  readonly chain: ChainId
  readonly logger: Logger
  readonly metrics: Metrics
  readonly proposer: Proposer
  readonly proposalBatchSize: number
  readonly proposeEveryMinutes: number
  readonly deploy: DeployDeps
  readonly resolve: ResolveDeps
  readonly mirror: MirrorDeps
  readonly ledger: LedgerClient
  readonly now?: () => Date
}

/* ------------------------------------------------------------------ the idea pipeline */

/**
 * Search, ask a model, store what comes back as PROPOSALS.
 *
 * Re-enqueues itself at the end, so recurrence needs no timer. `onConflict: 'keep'` on the enqueue
 * means three calls before the first runs still produce one run.
 *
 * An unconfigured proposer is a normal outcome: the run records "not configured", completes, and
 * schedules the next one. It does not throw, so nothing backs off into a dead letter and nothing
 * logs an error every six hours for a thing nobody has set up.
 */
export function ideaProposeHandler(deps: JobDeps): Handler {
  return async (job) => {
    const now = (deps.now ?? (() => new Date()))()
    try {
      if (!deps.proposer.configured) {
        deps.logger.info('idea pipeline: no proposer is configured, so there are no proposals', {
          jobKey: job.key,
        })
        deps.metrics.increment('foresight_idea_runs_total', { outcome: 'not_configured' })
        return
      }

      let stored = 0
      let dropped = 0
      for (const topic of PROPOSAL_TOPICS) {
        const run = await deps.proposer.propose({
          topic,
          count: deps.proposalBatchSize,
          now,
        })
        deps.metrics.increment('foresight_idea_runs_total', { outcome: run.reason })
        for (const proposal of run.proposals) {
          try {
            await insertIdea(deps.sql, { ...proposal, categoryVersion: CATEGORY_VERSION }, now)
            stored += 1
          } catch (err) {
            // A proposal that fails validation is DROPPED and counted, never repaired. Filling in a
            // missing resolution source with a plausible default is how a market ends up settling
            // from somewhere nobody named.
            if (err instanceof IdeaError) {
              dropped += 1
              deps.metrics.increment('foresight_proposals_dropped_total', { reason: err.code })
              continue
            }
            throw err
          }
        }
      }
      deps.logger.info('idea pipeline ran', { stored, dropped })
      deps.metrics.increment('foresight_proposals_stored_total', {}, stored)
    } finally {
      // Scheduled in a `finally` so a failed run still schedules the next one. A pipeline that
      // stops recurring because one search timed out is a pipeline that quietly dies.
      await deps.queue.enqueue({
        kind: IDEA_PROPOSE,
        key: 'global',
        runAt: new Date(now.getTime() + deps.proposeEveryMinutes * 60_000),
        onConflict: 'keep',
      })
    }
  }
}

/* ------------------------------------------------------------------ deploy */

export function marketDeployHandler(deps: JobDeps): Handler {
  return async (job, ctx) => {
    const marketId = typeof job.payload['marketId'] === 'string' ? job.payload['marketId'] : job.key
    const result = await driveDeploy(deps.deploy, marketId)
    await ctx.heartbeat()
    if (result === 'broadcast' || result === 'pending' || result === 'awaiting_funds') {
      // Not finished, and not a failure. Re-enqueued rather than left to a sweep so the common case
      // is fast; the sweep below is what catches a row nothing re-enqueued.
      await deps.queue.enqueue({
        kind: MARKET_DEPLOY,
        key: marketId,
        payload: { marketId },
        runAt: new Date(Date.now() + 15_000),
        onConflict: 'earliest',
      })
    }
    if (result === 'deployed') {
      // The mirror starts following the moment there is something to follow.
      await deps.queue.enqueue({ kind: MIRROR_SYNC, key: marketId, payload: { marketId } })
    }
  }
}

/**
 * The sweep: walk every outstanding deploy.
 *
 * `micro-mint`'s `chain.sweep`, and the defect it names is worth restating — the frozen service had
 * no reconciler at all, so a customer who closed the tab left a broadcast deploy in `deploying` for
 * ever. Here nothing depends on a request ever coming back.
 */
export function deploySweepHandler(deps: JobDeps): Handler {
  return async () => {
    const outstanding = await listOutstandingDeploys(deps.sql, 50)
    for (const market of outstanding) {
      await deps.queue.enqueue({
        kind: MARKET_DEPLOY,
        key: market.id,
        payload: { marketId: market.id },
        onConflict: 'earliest',
      })
    }
  }
}

/* ------------------------------------------------------------------ close */

/**
 * Close every market whose time is up.
 *
 * **Bookkeeping only.** The CONTRACT stops taking stakes at `closeTime` by itself; if this job
 * never ran, not one extra wei could be staked. What it buys is that the operator queue and the
 * public page agree with the chain, and that the resolution queue has something to work from.
 */
export function marketCloseHandler(deps: JobDeps): Handler {
  return async () => {
    const now = (deps.now ?? (() => new Date()))()
    const due = await listDueToClose(deps.sql, now, 100)
    for (const market of due) {
      await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
        await closeMarket(tx, emit, market.id, `service:${deps.producer}`, now, null)
      })
      deps.metrics.increment('foresight_markets_closed_total')
    }
    // One scan per minute, re-enqueued. `keep` collapses a burst into one pending run.
    await deps.queue.enqueue({
      kind: MARKET_CLOSE,
      key: 'global',
      runAt: new Date(now.getTime() + 60_000),
      onConflict: 'keep',
    })
  }
}

/* ------------------------------------------------------------------ mirror */

export function mirrorSyncHandler(deps: JobDeps): Handler {
  return async (job) => {
    const marketId = typeof job.payload['marketId'] === 'string' ? job.payload['marketId'] : job.key
    try {
      const result = await syncMarket(deps.mirror, marketId)
      deps.logger.debug('mirror synced', { marketId, ...result })
    } catch (err) {
      // Recorded on the cursor and swallowed. A mirror that cannot reach the indexer is a DEGRADED
      // read, and the page says "as of" rather than showing a smaller pool — throwing here would
      // dead-letter the job and stop the market ever syncing again.
      const message = err instanceof Error ? err.message : String(err)
      await recordSyncError(deps.sql, marketId, message)
      deps.metrics.increment('foresight_mirror_errors_total')
      deps.logger.warn('mirror sync failed', { marketId, err: message })
    }
    await deps.queue.enqueue({
      kind: MIRROR_SYNC,
      key: marketId,
      payload: { marketId },
      runAt: new Date(Date.now() + 30_000),
      onConflict: 'keep',
    })
  }
}

/* ------------------------------------------------------------------ resolution */

/**
 * Post outstanding resolutions on one chain, one at a time.
 *
 * The key is the CHAIN, so this handler is the only thing on a replica touching that oracle's
 * nonce. Resolutions are driven serially inside it for the same reason: two in flight at once would
 * need two nonces read before either was mined.
 */
export function resolutionPostHandler(deps: JobDeps): Handler {
  return async (_job, ctx) => {
    const outstanding = await listOutstandingResolutions(deps.sql, 20)
    for (const resolution of outstanding) {
      const result = await driveResolution(deps.resolve, resolution.id)
      await ctx.heartbeat()
      if (result === 'confirmed') {
        await applyConfirmedResolution(deps, resolution.marketId, resolution.action, resolution.rationale)
      }
      // One at a time: the next resolution needs a nonce that only exists once this one is mined.
      if (result === 'broadcast' || result === 'pending') break
    }
    if (outstanding.length > 0) {
      await deps.queue.enqueue({
        kind: RESOLUTION_POST,
        key: resolutionLeaseKey(deps.chain, deps.network),
        runAt: new Date(Date.now() + 15_000),
        onConflict: 'earliest',
      })
    }
  }
}

/**
 * Write down what the chain has already accepted.
 *
 * **After, never before.** The outcome exists on chain by the time this runs — `driveResolution`
 * returned `confirmed`, which means a receipt with status 1. Writing the row first would make the
 * database the source of truth for an outcome the contract pays against, which is the inversion
 * §2.3.1 forbids.
 */
export async function applyConfirmedResolution(
  deps: JobDeps,
  marketId: string,
  action: number,
  rationale: string,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  const actor = `service:${deps.producer}`
  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    if (action === ACTION_VOID) {
      await voidMarket(tx, emit, marketId, rationale, actor, now, null)
      deps.metrics.increment('foresight_markets_voided_total')
      return
    }
    await markResolved(tx, emit, marketId, action, actor, now, null)
    deps.metrics.increment('foresight_markets_resolved_total')
  })
}

/* ------------------------------------------------------------------ fees */

/**
 * Report indexed settlement fees to the ledger.
 *
 * The row exists because a `FeePaid` log was indexed. This posts it and marks the market settled —
 * bookkeeping that mirrors a transfer which has already happened on a public chain and which
 * nothing here authorised.
 */
export function feeReportHandler(deps: JobDeps): Handler {
  return async () => {
    const pending = await deps.sql<
      { id: string; market_id: string; amount_wei: string; tx_hash: string }[]
    >`
      select id, market_id, amount_wei, tx_hash from fee_reports
       where reported_at is null order by created_at limit 25
    `
    for (const row of pending) {
      try {
        const entry = await deps.ledger.postEntry({
          kind: 'foresight.settlement_fee',
          actor: `service:${deps.producer}`,
          correlationId: row.market_id,
          idempotencyKey: feeIdempotencyKey(row.market_id),
          description: `settlement fee taken on chain by market ${row.market_id} (${row.tx_hash})`,
          postings: feePostings({ amountWei: BigInt(row.amount_wei), chain: deps.chain }),
        })
        await deps.sql`
          update fee_reports set reported_at = now(), ledger_entry_id = ${entry.id} where id = ${row.id}
        `
        const now = (deps.now ?? (() => new Date()))()
        await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
          await markSettled(tx, emit, row.market_id, `service:${deps.producer}`, now, null)
        }).catch(() => {
          // The market may already be settled or void. The fee report is what this job is for and
          // it succeeded; a status that has moved on is not a reason to repost the entry.
        })
      } catch (err) {
        if (err instanceof LedgerUnavailableError) {
          // Left unreported, deliberately. The idempotency key makes the retry a replay, so the
          // only cost of waiting is a delay in a report — and the money moved on chain regardless.
          deps.logger.warn('fee report deferred: the ledger was unavailable', {
            marketId: row.market_id,
            err: err.message,
          })
          return
        }
        throw err
      }
    }
  }
}

/* ------------------------------------------------------------------ registration */

/** Everything a runner needs, in one place, so a job cannot exist without a documented key. */
export function registerHandlers(
  deps: JobDeps,
  relay: Handler,
  register: (kind: string, handler: Handler) => void,
): void {
  register(IDEA_PROPOSE, ideaProposeHandler(deps))
  register(MARKET_DEPLOY, marketDeployHandler(deps))
  register(MARKET_CLOSE, marketCloseHandler(deps))
  register(MIRROR_SYNC, mirrorSyncHandler(deps))
  register(RESOLUTION_POST, resolutionPostHandler(deps))
  register(FEE_REPORT, feeReportHandler(deps))
  register(OUTBOX_RELAY, relay)
}

/**
 * The recurring jobs, enqueued at boot.
 *
 * `onConflict: 'keep'` throughout, so N replicas booting together produce one pending run of each
 * rather than N. The `(kind, key)` unique constraint in `JOBS_SCHEMA_SQL` is what makes that true.
 */
export async function seedRecurring(queue: JobQueue, chain: ChainId, network: Network): Promise<void> {
  await queue.enqueue({ kind: IDEA_PROPOSE, key: 'global', onConflict: 'keep' })
  await queue.enqueue({ kind: MARKET_CLOSE, key: 'global', onConflict: 'keep' })
  await queue.enqueue({ kind: FEE_REPORT, key: 'global', onConflict: 'keep' })
  await queue.enqueue({ kind: OUTBOX_RELAY, key: 'global', onConflict: 'keep' })
  await queue.enqueue({
    kind: RESOLUTION_POST,
    key: resolutionLeaseKey(chain, network),
    onConflict: 'keep',
  })
}

export { chainKey }
