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
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { CATEGORY_VERSION } from './categories.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, seedRecurring, type JobDeps } from './jobs.ts'
import { createRelay } from './outbox.ts'
import { httpCustodyClient } from './custodyclient.ts'
import { httpIndexerClient } from './indexerclient.ts'
import { httpLedgerClient } from './ledgerclient.ts'
import { httpPolicyClient } from './policyclient.ts'
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
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a connection
  // string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The upstreams. Constructed before the Lifecycle so its probes can close over their URLs, and
//    all four take the same scoped service token — never a shared one (SD-05).
const token = () => env.serviceToken
const custody = httpCustodyClient({
  baseUrl: env.custodyUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
})
const indexer = httpIndexerClient({
  baseUrl: env.indexerUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
})
const ledger = httpLedgerClient({
  baseUrl: env.ledgerUrl,
  token,
  deadlineMs: env.upstreamDeadlineMs,
  originatingService: SERVICE,
})
const policy = httpPolicyClient({
  baseUrl: env.policyUrl,
  token,
  deadlineMs: env.policyDeadlineMs,
  action: env.policyAction,
})
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

// 7. The dependency bundles, built once and shared so the routes and the worker cannot disagree
//    about which network they are on or which bounds they are enforcing.
const db = sql as unknown as Db
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // Longer than the default 60 seconds because a deploy job holds its lease across a node round
  // trip, a custody round trip and a broadcast. The handler renews between steps, so this is the
  // ceiling on a STEP rather than on the job.
  leaseMs: 120_000,
})

const bounds = { minGasPriceWei: env.minGasPriceWei, maxGasPriceWei: env.maxGasPriceWei }

const deploy: DeployDeps = {
  sql: db,
  producer: SERVICE,
  owner: env.instanceId,
  network: env.network,
  custody,
  rpc,
  bounds,
  gasLimit: env.deployGasLimit,
  treasuryAddress: env.treasuryAddress,
  oracleAddress: env.oracleAddress,
  leaseMs: 120_000,
  stuckMs: env.stuckMinutes * 60_000,
  enabled: env.deploysEnabled,
  logger: logger.child({ component: 'deploy' }),
  metrics,
}

const resolve: ResolveDeps = {
  sql: db,
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
}

const mirror: MirrorDeps = {
  sql: db,
  indexer,
  pageSize: 100,
  logger: logger.child({ component: 'mirror' }),
  metrics,
}

const sourceProbe = httpSourceProbe(env.upstreamDeadlineMs)

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  sql: db,
  queue,
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
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const jobDeps: JobDeps = {
  sql: db,
  queue,
  producer: SERVICE,
  network: env.network,
  chain: CHAIN,
  logger,
  metrics,
  proposer,
  proposalBatchSize: env.proposerBatchSize,
  proposeEveryMinutes: env.proposeEveryMinutes,
  deploy,
  resolve,
  mirror,
  ledger,
}

const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: env.jobPollMs,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
  },
})

registerHandlers(
  jobDeps,
  createRelay({
    sql: db,
    logger: logger.child({ component: 'relay' }),
    signingSecret: env.outboxSigningSecret,
  }),
  (kind, handler) => runner.register(kind, handler),
)
await seedRecurring(queue, CHAIN, env.network)
runner.start()

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
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
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
