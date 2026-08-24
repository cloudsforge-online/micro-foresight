/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a separate
 * one-shot process — AD-17 and rule 7. In this service that is more than hygiene: below
 * `SCHEMA_VERSION` the constraints described in `migrations.ts` may not exist, and one of them —
 * `markets_unapproved_never_opens` — is what makes "a machine's proposal opened a market" an
 * impossible row rather than an unlikely one. A service that could create it at boot is a service
 * that could start without it.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql , networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { recurringJobs, registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { createRelay } from './outbox.ts'
import { buildUpstreams } from './upstreams.ts'
import { createProposer } from './proposer.ts'
import { rpcRouter, type DeployDeps } from './deploy.ts'
import { httpSourceProbe, type ResolveDeps } from './resolve.ts'
import type { MirrorDeps } from './mirror.ts'
import type { ChainId } from './chains.ts'
import type { Db } from './outbox.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))

const CHAIN: ChainId = 'ember'
const proposer = createProposer({
  searchUrl: env.searchUrl,
  searchToken: env.searchToken,
  proposerUrl: env.proposerUrl,
  proposerToken: env.proposerToken,
  modelId: env.proposerModelId,
  deadlineMs: env.proposerDeadlineMs,
})

logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  categoryVersion: CATEGORY_VERSION,
  network: env.network,
  // Said at boot rather than discovered from a refused deploy an hour later.
  rpcConfigured: Boolean(env.rpcUrls[CHAIN]),
  // Unconfigured is a supported mode and this is how an operator sees which one they are in,
  // without an error line every six hours for a thing nobody has set up.
  proposerConfigured: proposer.configured,
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a connection
  // string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `FORESIGHT_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

// 4. Assert the schema on EVERY network. This does NOT migrate. Failing here rather than serving
//    is the point — and a testnet database behind on migrations would otherwise be discovered by
//    the first testnet request rather than at boot.
for (const [network, handle] of [
  ['mainnet', sql] as const,
  ...(sqlTestnet ? ([['testnet', sqlTestnet]] as const) : []),
]) {
  try {
    await assertSchemaAtLeast(handle as unknown as DbSql, SCHEMA_VERSION)
  } catch (err) {
    logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION, network })
    await sql.end({ timeout: 5 }).catch(() => {})
    await sqlTestnet?.end({ timeout: 5 }).catch(() => {})
    process.exit(1)
  }
}

// 5. The upstreams. Constructed before the Lifecycle so its probes can close over their URLs, and
//    all five take the same scoped service credential — never a shared one (SD-05).
//
//    ══════════════════════════════════════════════════════════════════════════════════════════
//    **THE CREDENTIAL IS EXCHANGED, NOT READ ONCE.** The line that used to be here was
//
//        const token = () => env.serviceToken
//
//    — a function called per request, returning a string read once at import from a token that
//    expires in 600 seconds. This service's custody calls come from LEASED JOBS that run every
//    fifteen seconds for ever, so it authenticated once per bootstrap and then presented a dead
//    token to custody, the indexer, the ledger, policy and admin-api for the rest of the process's
//    life — and the 401 that came back was recorded as custody refusing us or custody being down,
//    which sends an operator to the wrong service entirely.
//
//    The seam was right and the body was wrong, which is why the body now lives in `upstreams.ts` —
//    a module a test can import without starting a server, and the only way to write a test that
//    fails when THIS FILE regresses. That file carries the argument, including why the credential
//    is deliberately NOT wired to a hard readiness probe here.
//    ══════════════════════════════════════════════════════════════════════════════════════════
const upstreams = buildUpstreams(env, {
  originatingService: SERVICE,
  onEvent: (event) => {
    metrics.increment('foresight_service_token_events_total', { kind: event.kind })
    if (event.kind === 'minted') {
      logger.info('minted a service token from the credential', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else if (event.kind === 'exchange_failed') {
      // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
      // token is still held is the outage this provider is built to ride out, and paging on it
      // would page on every identity blip.
      logger.warn('service credential exchange failed', { ...event })
    }
  },
})
const { custody, indexer, ledger, policy, pricing } = upstreams

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Said at boot, at the level its consequence deserves, because the alternative is discovering it as
// a 401 nine minutes later that names the wrong service.
// ────────────────────────────────────────────────────────────────────────────────────────────────
if (upstreams.mode === 'none') {
  logger.fatal('NO CREDENTIAL AT ALL — every deploy, resolution, fee report and stake intent will fail', {
    remedy: 'set FORESIGHT_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
  })
} else if (upstreams.mode === 'static') {
  logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every upstream call will 401 about ten minutes from now', {
    // Said out loud so the failure an operator will hit is one they can search for.
    whatWillHappen:
      'FORESIGHT_SERVICE_TOKEN lives 600s and nothing can renew it. market.deploy and resolution.post ' +
      'run every 15s from a leased job, so from minute ten custody refuses every signature and the log ' +
      'will say custody refused or custody was unavailable, which is NOT the cause.',
    remedy:
      'set FORESIGHT_IDENTITY_CREDENTIAL in the deploy; estate-bootstrap.sh section 5b already mints it',
  })
}

const rpc = rpcRouter(env.rpcUrls, env.rpcDeadlineMs)

// 6. Lifecycle and its probes.
const lifecycle = new Lifecycle({
  // The drain budget. A deploy or resolution job renews its lease between steps and is given 20
  // seconds below; this is the ceiling around it.
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE HARD/SOFT SPLIT, AND IT IS DELIBERATE IN BOTH DIRECTIONS.
  //
  // SOFT: custody, the indexer, the ledger. The indexer being down means the mirror is stale, and
  // a stale mirror is a page that says "as of 14 minutes ago" — taking this service out of rotation
  // over that would turn somebody else's incident into an outage of a product that still works.
  // Custody being down means no NEW contract can be signed, but this service must stay in its
  // balancer to keep advancing deploys that are already signed, which is where gas is actually at
  // risk. The ledger being down defers a fee REPORT about money that has already moved on chain.
  //
  // Postgres is the only hard probe, because without it this service cannot answer any question at
  // all. Policy is not probed here: it is checked per request and fails CLOSED there
  // (`policyclient.ts`), which is a stronger statement than a readiness probe would make — a stake
  // intent is refused whether or not this replica is in rotation.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  .addProbe(httpProbe('custody', `${env.custodyUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('indexer', `${env.indexerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('policy', `${env.policyUrl}/livez`, { kind: 'soft' }))
  // SOFT, and only when there is one to probe. Pricing being down stops a NON-EMBER stake being
  // taken — the route refuses with `rate_unavailable` at the point of use — and stops nothing else
  // this service does. A hard probe would take the whole service out of rotation for a feature most
  // requests do not touch, which is the trade `ledger/src/upstreams.ts` declines for the same shape
  // of dependency. An UNSET url probed anyway would report `undefined/livez` unreachable for ever,
  // which is a permanently amber readiness page saying nothing true.

if (env.pricingUrl !== undefined) {
  lifecycle.addProbe(httpProbe('pricing', `${env.pricingUrl}/livez`, { kind: 'soft' }))
}

// 7. The dependency bundles, built once and shared so the routes and the worker cannot disagree
//    about which network they are on or which bounds they are enforcing.
const db = sql as unknown as Db
// ── ONE QUEUE PER NETWORK ────────────────────────────────────────────────────────────────────
//
// An enqueue is a WRITE, and a resolution job is the most consequential one this service makes:
// it posts an outcome to a chain. `resolutionLeaseKey(chain, network)` is also half the key that
// stops two replicas posting the same resolution, so one shared queue would let a mainnet job
// suppress a testnet one as a duplicate.
const queueFor = (handle: typeof sql) =>
  new JobQueue(handle as unknown as JobsSql, {
    owner: env.instanceId,
    // Longer than the default 60 seconds because a deploy job holds its lease across a node round
    // trip, a custody round trip and a broadcast. The handler renews between steps, so this is the
    // ceiling on a STEP rather than on the job.
    leaseMs: 120_000,
  })

/** One plane per network: pool, handle, queue. Nothing crosses between two. */
const planes = [
  { network: 'mainnet' as const, pool: sql, db, queue: queueFor(sql) },
  ...(sqlTestnet
    ? [
        {
          network: 'testnet' as const,
          pool: sqlTestnet,
          db: sqlTestnet as unknown as Db,
          queue: queueFor(sqlTestnet),
        },
      ]
    : []),
]
const planeFor = (network: 'mainnet' | 'testnet') => {
  const plane = planes.find((p) => p.network === network)
  if (!plane) throw new Error(`no plane for network ${network}`)
  return plane
}
const queue = planeFor('mainnet').queue

// What the recurring schedule is computed from. Declared here, before the routes, because
// `beforeScrape` reads it and because `rescheduleRecurring` and `seedRecurring` below must be given
// the SAME values — a re-arm keyed on a different chain than the seed would arm a row nothing runs.
const schedule = { chain: CHAIN, network: env.network, proposeEveryMinutes: env.proposeEveryMinutes }

const bounds = { minGasPriceWei: env.minGasPriceWei, maxGasPriceWei: env.maxGasPriceWei }

/**
 * The deploy worker's dependencies, per network.
 *
 * `network` selects the CHAIN a market contract is deployed to and the custody key that signs it.
 * One worker per network, each closed over its own handle and its own network, is the only shape
 * where a testnet market cannot deploy against mainnet.
 */
const deployFor = (handle: Db, network: 'mainnet' | 'testnet'): DeployDeps => ({
  sql: handle,
  producer: SERVICE,
  owner: env.instanceId,
  network,
  custody,
  rpc,
  bounds,
  gasLimit: env.deployGasLimit,
  treasuryAddress: env.treasuryAddress,
  oracleAddress: env.oracleAddress,
  leaseMs: 120_000,
  stuckMs: env.stuckMinutes * 60_000,
  enabled: env.deploysEnabled,
  logger: logger.child({ component: 'deploy', network }),
  metrics,
})

const resolveFor = (handle: Db): ResolveDeps => ({
  sql: handle,
  owner: env.instanceId,
  custody,
  rpc,
  bounds,
  gasLimit: env.resolveGasLimit,
  oracleAddress: env.oracleAddress,
  oracleUserId: env.oracleUserId,
  oracleOrderId: env.oracleOrderId,
  leaseMs: 120_000,
  enabled: env.deploysEnabled,
  logger: logger.child({ component: 'resolve' }),
  metrics,
})

const mirrorFor = (handle: Db): MirrorDeps => ({
  sql: handle,
  indexer,
  pageSize: 100,
  logger: logger.child({ component: 'mirror' }),
  metrics,
})

const sourceProbe = httpSourceProbe(env.upstreamDeadlineMs)

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    mainnet: sql as unknown as RuntimeSql,
    ...(sqlTestnet ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as 'mainnet' | 'testnet' } : {}),
  // Boot-time values; `forRequest` replaces both with this request's network before any route sees
  // them. `network` is not a label here — it selects the chain a resolution is posted to.
  queue,
  queueFor: (network: 'mainnet' | 'testnet') => planeFor(network).queue,
  verifier,
  lifecycle,
  logger,
  metrics,
  policy,
  sourceProbe,
  producer: SERVICE,
  chain: CHAIN,
  network: env.network,
  defaultFeeBps: env.defaultFeeBps,
  defaultDisputeWindowSeconds: env.defaultDisputeWindowSeconds,
  // The house seed — 21 §5. Both may be absent, and absent means "no engagement programme
  // here": approving with a seed refuses with a sentence rather than degrading into one.
  houseAddress: env.houseAddress,
  engagementPolicies: upstreams.engagementPolicies,
  // The rate source and the ledger, for a stake denominated in something the pool is not. Both
  // fail closed: an unreadable rate refuses the stake, and a ledger that does not answer leaves an
  // `accepted` row the reconciler finishes rather than a movement nobody recorded.
  pricing,
  ledger,
  // Absent is a supported mode: wallet stakes only, and the custodial routes say so.
  custodialAddress: env.custodialAddress,
  // Where a BROWSER can reach micro-studio, for an image's `bytesUrl`. Absent is a supported mode
  // and is the estate's current state — `bytesUrl` is then null, which is honest, rather than a
  // relative path that would resolve against this service's origin and 404.
  studioPublicUrl: env.studioPublicUrl,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // **HOW MANY OF THE RECURRING JOBS ACTUALLY EXIST RIGHT NOW.**
    //
    // The series exists because of how this service's schedule died: every handler re-enqueued its
    // own `(kind, key)` and the runner deleted that row a moment later, so `jobs` was EMPTY ten
    // minutes after every boot and every background thing — market lifecycle, the idea pipeline,
    // resolution, fee settlement — had silently stopped. Nothing alerted, because `jobs_pending: 0`
    // is exactly what a healthy idle queue looks like.
    //
    // It is not. This service has a fee report due every minute and a relay due every second, so
    // fewer than `recurringJobs().length` rows present is a schedule that has stopped, and it is
    // detectable in one scrape rather than by noticing an absence. Counted against the same table
    // `recurringJobs` builds, so a job added there is covered without touching this line.
    // ──────────────────────────────────────────────────────────────────────────────────────────
    const expected = recurringJobs(schedule)
    const present = await sql<{ n: number }[]>`
      select count(*)::int as n
        from jobs j
        join unnest(${expected.map((job) => job.kind)}::text[], ${expected.map((job) => job.key)}::text[])
          as wanted(kind, key)
          on wanted.kind = j.kind and wanted.key = j.key
    `
    metrics.set('foresight_jobs_recurring_present', present[0]?.n ?? 0)
    metrics.set('foresight_jobs_recurring_expected', expected.length)

    // Read out of the provider's own memory. `static` counts as usable because it is — for about
    // ten minutes — which is exactly why it needs the second gauge beside it rather than a kinder
    // reading of the first.
    metrics.set(
      'foresight_service_token_usable',
      upstreams.mode === 'exchanged'
        ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
          ? 1
          : 0
        : upstreams.mode === 'static'
          ? 1
          : 0,
    )
    metrics.set('foresight_service_token_static', upstreams.mode === 'static' ? 1 : 0)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const jobDepsFor = (plane: (typeof planes)[number]): JobDeps => ({
  sql: plane.db,
  queue: plane.queue,
  producer: SERVICE,
  network: plane.network,
  chain: CHAIN,
  logger,
  metrics,
  proposer,
  proposalBatchSize: env.proposerBatchSize,
  proposeEveryMinutes: env.proposeEveryMinutes,
  deploy: deployFor(plane.db, plane.network),
  resolve: resolveFor(plane.db),
  mirror: mirrorFor(plane.db),
  ledger,
})

// ────────────────────────────────────────────────────────────────────────────────────────────────
// **THE RE-ARM, AND WHY IT IS HERE RATHER THAN IN THE HANDLERS.**
//
// Every recurring handler in `jobs.ts` used to end by enqueuing its own `(kind, key)`. `enqueue` is
// `on conflict (kind, key) do nothing`, and the row it conflicted with was the handler's own — still
// present, still claimed. `JobRunner` then called `queue.complete(job.id)`, which is
// `delete from jobs where id = $1`. The row the reschedule "made" and the row the delete removed
// were the same row, so this service's entire schedule stopped at the first completion after every
// boot: `jobs` was observed EMPTY 47 minutes into a live run while nine sibling services had rows,
// and the outbox showed it plainly — each event's `published_at` was the timestamp of the NEXT
// container boot, because the relay only ever ran once, at start.
//
// `completed` is emitted after `complete()` has resolved, so it is the first moment the row is
// provably gone and an enqueue can insert rather than conflict. `ledger/src/jobs.ts` names
// this trap and this is its fix, unchanged; six services already do it this way and there is no
// reason for a seventh pattern.
// ────────────────────────────────────────────────────────────────────────────────────────────────
// ── ONE RUNNER PER NETWORK ──────────────────────────────────────────────────────────────────
//
// Bulkheaded, and here that is not a tidiness argument: `deploy.network` and `jobDeps.network`
// select the CHAIN a market contract is deployed to and an outcome posted to. One runner over one
// queue would have every testnet market resolving against mainnet. `resolutionLeaseKey(chain,
// network)` also stops two replicas posting the same resolution — sharing a queue across estates
// would let a mainnet job suppress a testnet one as a duplicate.
const runners = planes.map((plane) => {
  const scheduleFor = { chain: CHAIN, network: plane.network, proposeEveryMinutes: env.proposeEveryMinutes }
  const reschedule = rescheduleRecurring(plane.queue, logger, scheduleFor)
  const runner = new JobRunner({
    queue: plane.queue,
    concurrency: 4,
    pollMs: env.jobPollMs,
    shouldClaim: () => lifecycle.claimingJobs,
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind, network: plane.network }
        if (event.type === 'claimed') metrics.increment('jobs_claimed_total', labels)
        if (event.type === 'completed') metrics.increment('jobs_completed_total', labels)
        if (event.type === 'failed') metrics.increment('jobs_failed_total', labels)
        if (event.type === 'dead') metrics.increment('jobs_dead_total', labels)
        if (event.durationMs !== undefined) {
          metrics.observe('jobs_duration_ms', event.durationMs, labels)
        }
      }
      if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
        logger.error('job failure', { ...event, network: plane.network })
      }
      reschedule(event)
    },
  })

  registerHandlers(
    jobDepsFor(plane),
    createRelay({
      sql: plane.db,
      logger: logger.child({ component: 'relay', network: plane.network }),
      signingSecret: env.outboxSigningSecret,
    }),
    (kind, handler) => runner.register(kind, handler),
  )
  return { runner, schedule: scheduleFor, queue: plane.queue }
})
for (const r of runners) await seedRecurring(r.queue, r.schedule)
for (const r of runners) r.runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//     exist is a socket that answers 500.
await new Promise<void>((resolve_, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve_())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS — which is the step that matters: a SIGTERM
//     between a signature and its commit discards bytes that were made and never sent, which is
//     safe but wastes a custody signature and a nonce read. Then the pool closes with nothing left
//     to use it.
lifecycle.onShutdown(async () => {
  await Promise.all(planes.map((plane) => plane.pool.end({ timeout: 5 })))
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = (await Promise.all(runners.map((r) => r.runner.stop(20_000)))).every(Boolean)
  logger.info('job runners stopped', { clean, runners: runners.length })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve_) => {
      server.close(() => resolve_())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
