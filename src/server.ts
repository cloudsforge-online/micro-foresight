/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO ROUTE HERE THAT MOVES MONEY, HOLDS MONEY, OR COULD.**
 *
 * A stake goes wallet → contract. What this service offers is `POST /markets/:id/stake-intent`,
 * which answers with the contract address, the calldata and the policy verdict — everything a
 * wallet needs to build a transaction it will sign itself. The EMBER never comes near this process,
 * and there is no code path by which it could: nothing here has a key.
 *
 * `POST /markets/:id/deploy` and `/resolve` answer **202** with a status URL and reach no chain.
 * `micro-mint`'s rule, for its reason: a rolling deploy kills a request mid-flight, and the bad
 * landing is between a broadcast and the write that records it. A 202 is not a nicety — it is the
 * only shape in which the work can survive the process that started it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The one decision that is easy to get backwards is the auth-fault mapping. A bad token is 401. A
 * verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs every
 * user in the estate out because identity is having a bad minute.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireAdmin,
  statusFor,
  type Principal,
  type Verifier,
} from '@cloudsforge/auth'
import type { Network } from '@cloudsforge/contracts-chain'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import type { JobQueue } from '@cloudsforge/jobs'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { CATEGORIES, CATEGORY_VERSION, REFUSALS } from './categories.ts'
import type { ChainId } from './chains.ts'
import { callData } from './evm.ts'
import { IdeaError, approveIdea, discardIdea, editIdea, findIdea, insertIdea, listIdeas } from './ideas.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import { MARKET_DEPLOY, RESOLUTION_POST } from './jobs.ts'
import {
  MarketError,
  approveMarket,
  createDraft,
  documentFor,
  findMarket,
  listMarkets,
  openMarket,
  publicView,
  voidMarket,
  type MarketStatus,
} from './markets.ts'
import { poolOf, positionOf } from './mirror.ts'
import { canonicalDocument } from './questiondoc.ts'
import { withOutbox, type Db } from './outbox.ts'
import type { PolicyClient } from './policyclient.ts'
import {
  ResolutionError,
  findResolutionByMarket,
  planResolution,
  resolutionLeaseKey,
  resolutionView,
  type SourceProbe,
} from './resolve.ts'

export interface ServerDeps {
  readonly sql: Db
  readonly queue: JobQueue
  readonly verifier: Verifier
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: PolicyClient
  readonly sourceProbe: SourceProbe
  readonly producer: string
  readonly chain: ChainId
  readonly network: Network
  readonly defaultFeeBps: number
  readonly defaultDisputeWindowSeconds: number
  readonly beforeScrape?: () => Promise<void>
  readonly now?: () => Date
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'foresight_deploys_total',
      help: 'Market deploys reaching a terminal state, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_deploys_broadcast_total',
      help: 'Creations that reached a node. Counted at the broadcast, not at the confirmation.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_deploys_stuck_total',
      help: 'Deploys broadcast and unconfirmed past the stuck threshold. An operator queue, not an error.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_resolutions_total',
      help: 'Oracle posts reaching a terminal state, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_resolutions_broadcast_total',
      help: 'Resolver creations that reached a node.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_markets_closed_total',
      help: 'Markets closed by the close job. Bookkeeping: the contract closes itself.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_markets_resolved_total',
      help: 'Markets recorded as resolved after the chain accepted the outcome.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_markets_voided_total',
      help: 'Markets voided. A missing named source shows up here, and refunds are whole.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_idea_runs_total',
      help: 'Idea pipeline runs by outcome. `not_configured` is a supported mode, not a fault.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'foresight_proposals_stored_total',
      help: 'Model proposals stored for an operator to judge. None of them can open a market.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_proposals_dropped_total',
      help: 'Model proposals refused at the gate, by reason. A rising `bad_category` means the prompt drifted.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'foresight_mirror_syncs_total',
      help: 'Mirror passes completed.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_mirror_errors_total',
      help: 'Mirror passes that could not reach the indexer. The pool then reads `as of` an older block.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'foresight_stake_intents_total',
      help: 'Stake intents by policy verdict. `degraded` means policy was unreachable and staking refused.',
      kind: 'counter',
      labels: ['verdict'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** The stake amount, as a positive decimal string of whole EMBER. Never a JSON number. */
const DECIMAL = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,18})?$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/markets/:id/deploy` into a matcher. The segment pattern excludes `/` so a parameter
 * cannot swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    // Unmatched paths collapse to one label. Using the raw path would let any caller mint unbounded
    // time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

/**
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be legal. Fix it; retrying will not help.
 *   * **403** — a scope, a role, or a policy verdict.
 *   * **404** — something named does not exist.
 *   * **409** — well formed, but the state refuses it: a market already open, a proposal already
 *     decided, an idempotency key reused with a different body.
 *   * **503** — an upstream is unreachable, INCLUDING policy. Retrying IS the right response, which
 *     is what 503 tells a client and 500 does not.
 */
async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof MarketError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof ResolutionError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof IdeaError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_proposed' ? 409 : 400
      return errorReply(status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof Error && err.name === 'ChainError') {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // `degraded` but still ready: the indexer being down means the mirror is stale, and a stale
      // mirror is a page that says "as of" — not a reason to stop serving.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would lose
        // every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /**
     * What this platform will run a market on, and what it refuses. **Public and unauthenticated.**
     *
     * A refusal list behind a token is a refusal list nobody can hold the platform to.
     */
    define('GET', '/categories', async () => ({
      status: 200,
      body: {
        version: CATEGORY_VERSION,
        categories: CATEGORIES,
        refusals: REFUSALS,
      },
    })),

    /* ---------------------------------------------------------------- public reads */

    define('GET', '/markets', async (ctx, deps) => {
      const requested = ctx.url.searchParams.get('status')
      const status = requested === null ? null : parseStatus(requested)
      const limit = parseLimit(ctx.url.searchParams.get('limit'))
      const markets = await listMarkets(deps.sql, status, limit)
      return { status: 200, body: { markets: markets.map(publicView) } }
    }),

    /**
     * One market, with everything a bettor needs to judge it.
     *
     * The cited sources are here, and so is the canonical document and its hash — so a reader can
     * recompute `questionHash` themselves and check it against the contract, rather than taking the
     * platform's word that the criteria have not been edited since it opened.
     */
    define('GET', '/markets/:id', async (ctx, deps) => {
      const id = uuidParam(ctx, 'id')
      const market = await findMarket(deps.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      const pool = await poolOf(deps.sql, id, market.chain as ChainId)
      const idea = market.ideaId ? await findIdea(deps.sql, market.ideaId) : null
      return {
        status: 200,
        body: {
          market: publicView(market),
          pool,
          document: {
            canonical: canonicalDocument(documentFor(market)),
            hash: market.questionHash,
          },
          // The provenance, shown. §2.3.3: "sources are carried through to the public market page,
          // so a bettor can see *why* the market exists."
          provenance: idea
            ? {
                origin: idea.origin,
                searchQuery: idea.searchQuery,
                sources: idea.sources,
                modelId: idea.modelId,
                promptSha256: idea.promptSha256,
                proposedAt: idea.proposedAt.toISOString(),
              }
            : null,
        },
      }
    }),

    define('GET', '/markets/:id/positions/:address', async (ctx, deps) => {
      const id = uuidParam(ctx, 'id')
      const address = ctx.params['address'] ?? ''
      if (!EVM_ADDRESS.test(address)) throw new BadRequestError('address must be a 20-byte hex address')
      const market = await findMarket(deps.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      const position = await positionOf(deps.sql, id, address)
      const pool = await poolOf(deps.sql, id, market.chain as ChainId)
      return {
        status: 200,
        body: {
          marketId: id,
          address,
          position,
          // Repeated here deliberately. A portfolio page that shows a number without saying when it
          // was true is the page that makes somebody think the mirror is the ledger.
          asOf: pool.asOf,
          stale: pool.stale,
          contractAddress: market.contractAddress,
        },
      }
    }),

    /* ---------------------------------------------------------------- staking */

    /**
     * Everything a wallet needs to stake, and **not one wei passes through here.**
     *
     * The answer is the contract address, the calldata, and the policy verdict. The user's wallet
     * builds, signs and sends the transaction. This service could be switched off between this
     * response and the send, and the stake would still work.
     *
     * The policy gate is FAIL CLOSED — see `policyclient.ts`. If policy cannot be reached, this
     * answers 503 and no intent is issued.
     */
    define('POST', '/markets/:id/stake-intent', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const amount = requireDecimal(body, 'amount')
      const outcome = requireInteger(body, 'outcome', 0, 1)

      const market = await findMarket(deps.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.status !== 'open' || !market.contractAddress) {
        return errorReply(409, 'not_open', `this market is ${market.status}`, ctx.requestId)
      }
      const now = (deps.now ?? (() => new Date()))()
      if (market.closeTime.getTime() <= now.getTime()) {
        // The contract would refuse it anyway. Saying so here saves the user a failed transaction
        // and the gas that goes with it.
        return errorReply(409, 'closed', 'this market has reached its close time', ctx.requestId)
      }

      const verdict = await deps.policy.evaluateStake({
        subject: subjectOf(principal),
        marketId: id,
        amount,
        correlationId: ctx.requestId,
      })
      deps.metrics.increment('foresight_stake_intents_total', {
        verdict: verdict.degraded ? 'degraded' : verdict.decision,
      })
      if (verdict.degraded) {
        ctx.log.warn('stake refused: policy was unreachable', { marketId: id })
        return errorReply(
          503,
          'policy_unavailable',
          'staking is temporarily unavailable because the policy service could not be reached; retry shortly',
          ctx.requestId,
        )
      }
      if (verdict.decision === 'deny') {
        return errorReply(403, 'policy_denied', verdict.reasons.join(', ') || 'refused by policy', ctx.requestId)
      }

      return {
        status: 200,
        body: {
          marketId: id,
          chain: market.chain,
          network: market.network,
          to: market.contractAddress,
          // `stake(uint8)`, payable. The wallet sets `value` to the amount in wei; the service
          // deliberately does not compute that, because the wallet is what knows the user's
          // balance and what will actually be sent.
          data: callData('stake(uint8)', [{ type: 'uint8', value: BigInt(outcome) }]),
          outcome,
          amount,
          asset: 'EMBER',
          policy: { decision: verdict.decision, reasons: verdict.reasons, decisionId: verdict.decisionId },
          closeTime: market.closeTime.toISOString(),
        },
      }
    }),

    /* ---------------------------------------------------------------- the idea queue */

    define('GET', '/ideas', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const status = ctx.url.searchParams.get('status') ?? 'proposed'
      if (status !== 'proposed' && status !== 'approved' && status !== 'discarded') {
        throw new BadRequestError('status must be proposed, approved or discarded')
      }
      const ideas = await listIdeas(deps.sql, status, parseLimit(ctx.url.searchParams.get('limit')))
      return { status: 200, body: { ideas } }
    }),

    /** An operator writes a question themselves. The same validation the pipeline's output gets. */
    define('POST', '/ideas', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await insertIdea(
        deps.sql,
        {
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          categoryVersion: CATEGORY_VERSION,
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          suggestedCloseTime: requireDate(body, 'suggestedCloseTime'),
          origin: 'operator',
        },
        now,
      )
      return { status: 201, body: { idea } }
    }),

    define('PATCH', '/ideas/:id', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await editIdea(
        deps.sql,
        id,
        {
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          categoryVersion: CATEGORY_VERSION,
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          suggestedCloseTime: requireDate(body, 'suggestedCloseTime'),
        },
        now,
      )
      return { status: 200, body: { idea } }
    }),

    define('POST', '/ideas/:id/approve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await approveIdea(deps.sql, id, operatorOf(principal), optionalString(body, 'note') ?? null, now)
      return { status: 200, body: { idea } }
    }),

    define('POST', '/ideas/:id/discard', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const idea = await discardIdea(
        deps.sql,
        id,
        operatorOf(principal),
        requireString(body, 'refusalId'),
        optionalString(body, 'note') ?? null,
        now,
      )
      return { status: 200, body: { idea } }
    }),

    /* ---------------------------------------------------------------- the market lifecycle */

    define('POST', '/markets', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const body = await readJson(ctx.req)
      const now = (deps.now ?? (() => new Date()))()
      const ideaId = optionalString(body, 'ideaId')
      if (ideaId !== undefined && !UUID.test(ideaId)) throw new BadRequestError('ideaId must be a uuid')
      const market = await createDraft(
        deps.sql,
        {
          ...(ideaId !== undefined ? { ideaId } : {}),
          question: requireString(body, 'question'),
          resolutionCriteria: requireString(body, 'resolutionCriteria'),
          category: requireString(body, 'category'),
          resolutionSourceKind: requireString(body, 'resolutionSourceKind'),
          resolutionSourceRef: requireString(body, 'resolutionSourceRef'),
          closeTime: requireDate(body, 'closeTime'),
          disputeWindowSeconds:
            body['disputeWindowSeconds'] === undefined
              ? deps.defaultDisputeWindowSeconds
              : requireInteger(body, 'disputeWindowSeconds', 0, 30 * 86_400),
          feeBps:
            body['feeBps'] === undefined ? deps.defaultFeeBps : requireInteger(body, 'feeBps', 0, 1_000),
          network: deps.network,
          chain: deps.chain,
        },
        now,
      )
      return { status: 201, body: { market: publicView(market) } }
    }),

    /** **A person approves.** The one act the state machine and the schema both insist on. */
    define('POST', '/markets/:id/approve', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const now = (deps.now ?? (() => new Date()))()
      const market = await withOutbox(deps.sql, deps.producer, async (tx) =>
        approveMarket(tx, id, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(market) } }
    }),

    /**
     * Deploy the contract. **202, and it reaches no chain.**
     *
     * Idempotent on the client's key, and the key is what stops a retried request producing a
     * second contract. See `idempotency.ts` — the loss from a double-apply here is not a double
     * payment, it is two pools for one question.
     */
    define('POST', '/markets/:id/deploy', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const key = idempotencyKeyOf(ctx)
      const market = await findMarket(deps.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.status !== 'approved') {
        return errorReply(409, 'not_approved', `a market is deployed once approved; this one is ${market.status}`, ctx.requestId)
      }

      const outcome = await withIdempotency<Record<string, unknown>>(deps.sql, {
        originatingService: deps.producer,
        route: 'POST /markets/:id/deploy',
        clientKey: key,
        requestHash: requestFingerprint({ marketId: id, correlationId: ctx.requestId }),
        run: async () => {
          await deps.queue.enqueue({
            kind: MARKET_DEPLOY,
            key: id,
            payload: { marketId: id },
            onConflict: 'earliest',
          })
          return { marketId: id, accepted: true }
        },
      })
      return {
        status: 202,
        body: { ...outcome.result, replayed: outcome.replayed },
        headers: { location: `/markets/${id}` },
      }
    }),

    define('POST', '/markets/:id/open', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const now = (deps.now ?? (() => new Date()))()
      const market = await withOutbox(deps.sql, deps.producer, async (tx, emit) =>
        openMarket(tx, emit, id, operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(market) } }
    }),

    /**
     * Resolve. **202** — the plan is written and the chain work is a leased job.
     *
     * The source check happens inside `planResolution`, and it can turn a `resolve` into a `void`.
     * That is not the caller being overruled; it is the rule the market was opened under.
     */
    define('POST', '/markets/:id/resolve', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const outcome = requireInteger(body, 'outcome', 0, 1)
      const resolution = await planResolution(deps.sql, deps.sourceProbe, {
        marketId: id,
        outcome: outcome as 0 | 1,
        rationale: requireString(body, 'rationale'),
      })
      await deps.queue.enqueue({
        kind: RESOLUTION_POST,
        key: resolutionLeaseKey(deps.chain, deps.network),
        onConflict: 'earliest',
      })
      return {
        status: 202,
        body: {
          resolution: {
            id: resolution.id,
            marketId: resolution.marketId,
            action: resolution.action,
            rationale: resolution.rationale,
            state: resolution.state,
          },
        },
        headers: { location: `/markets/${id}/resolution` },
      }
    }),

    define('GET', '/markets/:id/resolution', async (ctx, deps) => {
      requireAdmin(await authenticate(ctx, deps))
      const id = uuidParam(ctx, 'id')
      const resolution = await findResolutionByMarket(deps.sql, id)
      if (!resolution) return errorReply(404, 'not_found', 'no resolution has been planned', ctx.requestId)
      // Narrowed, never the row: the row carries a bigint nonce that JSON.stringify throws on, and
      // the raw transaction. See `resolutionView` for both defects.
      return { status: 200, body: { resolution: resolutionView(resolution) } }
    }),

    /**
     * Void off-chain, for a market that has no contract yet.
     *
     * A DEPLOYED market is voided on chain — `POST /markets/:id/resolve` produces a `void` action
     * when the source is gone, and an operator who wants to void a live market does it through the
     * same oracle path. This route exists for the case where there is nothing on chain to void, and
     * it refuses anything else rather than letting the database and the contract disagree.
     */
    define('POST', '/markets/:id/void', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      requireAdmin(principal)
      const id = uuidParam(ctx, 'id')
      const body = await readJson(ctx.req)
      const market = await findMarket(deps.sql, id)
      if (!market) return errorReply(404, 'not_found', 'no market with that id', ctx.requestId)
      if (market.contractAddress) {
        return errorReply(
          409,
          'on_chain',
          'this market has a contract; void it through the oracle so the chain and the registry agree',
          ctx.requestId,
        )
      }
      const now = (deps.now ?? (() => new Date()))()
      const voided = await withOutbox(deps.sql, deps.producer, async (tx, emit) =>
        voidMarket(tx, emit, id, requireString(body, 'reason'), operatorOf(principal), now, ctx.requestId),
      )
      return { status: 200, body: { market: publicView(voided) } }
    }),
  ]
}

/* ------------------------------------------------------------------ helpers */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * The `operator:<id>` subject an approval is recorded under.
 *
 * **A service principal cannot produce one.** `requireAdmin` has already run, so this is a user
 * token with the admin role; a service token would have been refused before it got here. That is
 * the transport half of "the AI proposes; a person opens" — `ideas.ts` and the schema are the other
 * two halves, and all three have to fail for a machine's proposal to reach `open`.
 */
function operatorOf(principal: Principal): string {
  if (principal.kind !== 'user' || !isAdmin(principal)) {
    throw new ForbiddenError('operator')
  }
  return `operator:${principal.userId}`
}

function subjectOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/**
 * The client's idempotency key, required on the routes that can create a contract.
 *
 * Required rather than defaulted to the request id: a default derived per-attempt makes every retry
 * a fresh operation, which is the opposite of what the header is for.
 */
function idempotencyKeyOf(ctx: RequestContext): string {
  const key = headerOf(ctx.req, 'idempotency-key')
  if (!key || key.length < 8 || key.length > 200) {
    throw new BadRequestError('an Idempotency-Key header of 8 to 200 characters is required')
  }
  return key
}

function uuidParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name] ?? ''
  if (!UUID.test(value)) throw new BadRequestError(`${name} must be a uuid`)
  return value
}

function parseStatus(value: string): MarketStatus {
  const statuses = ['draft', 'approved', 'open', 'closed', 'resolved', 'settled', 'void']
  if (!statuses.includes(value)) throw new BadRequestError(`status must be one of ${statuses.join(', ')}`)
  return value as MarketStatus
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new BadRequestError('limit must be a whole number between 1 and 200')
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field)
  if (!value) throw new BadRequestError(`${field} is required`)
  return value
}

function requireInteger(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

/**
 * An amount, as a decimal STRING.
 *
 * A JSON number is refused rather than coerced. One EMBER is 1e18 wei, and `policy` refuses a
 * numeric amount for the same reason — a threshold comparison that has been through a double is a
 * comparison against a number nobody wrote.
 */
function requireDecimal(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new BadRequestError(`${field} must be a positive decimal string, not a number`)
  }
  return value
}

function requireDate(body: Record<string, unknown>, field: string): Date {
  const value = body[field]
  if (typeof value !== 'string') throw new BadRequestError(`${field} must be an ISO-8601 string`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${field} is not a valid instant`)
  return parsed
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive any
    // unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // A pool and a health check are point-in-time facts. A cached 200 from a replica that has since
    // gone unready — or a cached pool from before a hundred EMBER arrived — is exactly the lie this
    // arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
