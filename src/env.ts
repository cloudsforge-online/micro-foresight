/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## The two fail-closed defaults
 *
 * `FORESIGHT_MAINNET_ENABLED` is false, so a misconfigured deployment cannot put a market holding
 * real EMBER on a mainnet nobody authorised. And `FORESIGHT_PROPOSER_*` is unset by default, which
 * is a SUPPORTED MODE rather than an error: the idea pipeline records "no proposals" and the
 * operator queue stays empty. Same discipline as `micro-notify`'s unconfigured SMTP — an external
 * dependency nobody has wired yet must degrade, not crash.
 */

import { hostname } from 'node:os'
import type { Network } from '@cloudsforge/contracts-chain'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'foresight'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * Values that must never be accepted. The list holds the strings that actually appear in this
 * repository's own `.env.example`, because those are the ones that get copied into a deployment by
 * someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'change_me',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/** An optional value that stays absent rather than becoming an empty string. */
function optionalOrUndefined(source: Source, name: string): string | undefined {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : undefined
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * A wei quantity as a decimal string.
 *
 * Never a number. One EMBER is 1e18 wei, four orders of magnitude past what a double holds
 * exactly, so a gas bound read through `Number()` would be silently rounded — and a rounded bound
 * is a bound that does not hold at the value it was written for.
 */
function wei(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of wei (got ${raw})`)
  return BigInt(raw)
}

/**
 * A JSON object of `chain → value`, refused rather than defaulted when it will not parse.
 *
 * A silently-empty map here is an outage that presents as "every deploy is refused for want of an
 * endpoint", which is a long way from the typo that caused it.
 */
function jsonMap(source: Source, name: string, fallback: string): Readonly<Record<string, string>> {
  const raw = optional(source, name, fallback)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvError(`${name} must be a JSON object (got ${raw.slice(0, 60)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvError(`${name} must be a JSON object of string keys to string values`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new EnvError(`${name}.${key} must be a non-empty string`)
    }
    out[key] = value
  }
  return Object.freeze(out)
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

function address(source: Source, name: string): string {
  const value = required(source, name)
  if (!EVM_ADDRESS.test(value)) {
    throw new EnvError(`${name} must be an 0x-prefixed 20-byte address (got ${value.slice(0, 12)}…)`)
  }
  return value
}

/** An address that may be absent — but a PRESENT value must still be a real address. */
function optionalAddress(source: Source, name: string): string | undefined {
  const value = optionalOrUndefined(source, name)
  if (value === undefined) return undefined
  if (!EVM_ADDRESS.test(value)) {
    throw new EnvError(`${name} must be an 0x-prefixed 20-byte address (got ${value.slice(0, 12)}…)`)
  }
  return value
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string

  readonly custodyUrl: string
  readonly indexerUrl: string
  readonly ledgerUrl: string
  readonly policyUrl: string
  /** The scoped service credential. Not shared: SD-05. */
  readonly serviceToken: string
  readonly upstreamDeadlineMs: number

  /**
   * `chain → JSON-RPC endpoint`. Empty by default, which makes a chain with no endpoint refuse
   * rather than fall back to a public node nobody chose.
   */
  readonly rpcUrls: Readonly<Record<string, string>>
  readonly rpcDeadlineMs: number

  /** The one network this deployment runs markets on. */
  readonly network: Network
  /**
   * Whether `network: mainnet` is permitted at all. FALSE by default.
   *
   * A market on a mainnet holds real EMBER belonging to strangers, and the cost of a mistake here
   * is not a support ticket. So mainnet is a deliberate act of configuration and the default
   * refuses.
   */
  readonly mainnetEnabled: boolean

  /** Where the settlement fee goes. Bound into every market at deploy time. */
  readonly treasuryAddress: string
  /**
   * The published platform address the house seed stakes from — docs/ecosystem/21 §5. **May be
   * absent, and absent is a supported mode**: this deployment runs no engagement programme and
   * `POST /markets/:id/approve` refuses a `houseSeedPerOutcomeWei`, plainly. The address holds
   * its own key OUTSIDE this estate's custody (custody has no transaction shape that can call
   * `stake(uint8)` — see `src/houseseed.ts`), stakes exactly as any bettor does, and is
   * published the way the platform miners' coinbase addresses are (21 §3).
   */
  readonly houseAddress: string | undefined
  /**
   * micro-admin-api, for reading the engagement caps at market approval. Absent is the same
   * supported mode: no caps readable, no seeds planned (21 §8).
   */
  readonly adminApiUrl: string | undefined
  /** The custody-held address that may resolve or void a market. See `src/resolve.ts`. */
  readonly oracleAddress: string
  /** Custody's binding for the oracle key: the userId it was minted under. */
  readonly oracleUserId: string
  /** Custody's binding for the oracle key: the orderId it was minted under. */
  readonly oracleOrderId: string

  readonly defaultFeeBps: number
  readonly defaultDisputeWindowSeconds: number

  /** Deploys can be turned off without turning the service off. */
  readonly deploysEnabled: boolean
  readonly minGasPriceWei: bigint
  readonly maxGasPriceWei: bigint
  readonly deployGasLimit: bigint
  readonly resolveGasLimit: bigint
  /** How long a broadcast may sit unconfirmed before it is called stuck and an operator is told. */
  readonly stuckMinutes: number

  /**
   * The idea pipeline's external model and search adapter. **All four may be absent**, and absent
   * is a supported mode: the pipeline records "no proposals" instead of crashing.
   */
  readonly proposerUrl: string | undefined
  readonly proposerToken: string | undefined
  readonly proposerModelId: string | undefined
  readonly searchUrl: string | undefined
  readonly searchToken: string | undefined
  readonly proposerDeadlineMs: number
  /** How many candidate questions one pipeline run asks for. */
  readonly proposerBatchSize: number

  /**
   * The policy action name staking is evaluated under.
   *
   * `micro-policy`'s action registry is CLOSED — an unregistered name is a 400, not a guess
   * (`policy/src/actions.ts:88-165`). There is no `foresight.stake` in it and this task may not
   * modify that repository, so the default is the registered action whose description actually
   * fits ("Place an order. Soft per-window caps only." — `policy/src/actions.ts:143-147`). When
   * policy next gains a `foresight.stake` action, this variable is how a deployment moves to it
   * without a release here.
   */
  readonly policyAction: string
  readonly policyDeadlineMs: number

  readonly leaseMs: number
  readonly jobPollMs: number
  /** How often the idea pipeline runs, in minutes. A leased job, never a timer. */
  readonly proposeEveryMinutes: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const NETWORKS = new Set(['mainnet', 'testnet'])

export function parseNetwork(value: string): Network {
  if (!NETWORKS.has(value)) throw new EnvError(`network must be mainnet or testnet (got ${value})`)
  return value as Network
}

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const minGasPriceWei = wei(source, 'FORESIGHT_MIN_GAS_PRICE_WEI', 1_000_000_000n)
  const maxGasPriceWei = wei(source, 'FORESIGHT_MAX_GAS_PRICE_WEI', 500_000_000_000n)
  if (minGasPriceWei > maxGasPriceWei) {
    throw new EnvError('FORESIGHT_MIN_GAS_PRICE_WEI exceeds FORESIGHT_MAX_GAS_PRICE_WEI')
  }

  const network = parseNetwork(optional(source, 'FORESIGHT_NETWORK', 'testnet'))
  const mainnetEnabled = optional(source, 'FORESIGHT_MAINNET_ENABLED', 'false') === 'true'
  if (network === 'mainnet' && !mainnetEnabled) {
    // Two variables rather than one, so that reaching mainnet takes two deliberate edits. A single
    // `FORESIGHT_NETWORK=mainnet` typo would otherwise put strangers' money on a live chain.
    throw new EnvError(
      'FORESIGHT_NETWORK is mainnet but FORESIGHT_MAINNET_ENABLED is not true — a market on a ' +
        'mainnet holds real EMBER belonging to strangers, so it takes two deliberate settings',
    )
  }

  const defaultFeeBps = integer(source, 'FORESIGHT_DEFAULT_FEE_BPS', 200, 0, 1_000)

  return {
    port: integer(source, 'PORT', 4021, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'FORESIGHT_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'FORESIGHT_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    ledgerUrl: required(source, 'LEDGER_URL'),
    policyUrl: required(source, 'POLICY_URL'),
    serviceToken: requiredSecret(source, 'FORESIGHT_SERVICE_TOKEN'),
    upstreamDeadlineMs: integer(source, 'FORESIGHT_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    rpcUrls: jsonMap(source, 'FORESIGHT_RPC_URLS', '{}'),
    rpcDeadlineMs: integer(source, 'FORESIGHT_RPC_DEADLINE_MS', 5_000, 100, 60_000),
    network,
    mainnetEnabled,

    treasuryAddress: address(source, 'FORESIGHT_TREASURY_ADDRESS'),
    houseAddress: optionalAddress(source, 'FORESIGHT_HOUSE_ADDRESS'),
    adminApiUrl: optionalOrUndefined(source, 'ADMIN_API_URL'),
    oracleAddress: address(source, 'FORESIGHT_ORACLE_ADDRESS'),
    oracleUserId: required(source, 'FORESIGHT_ORACLE_USER_ID'),
    oracleOrderId: required(source, 'FORESIGHT_ORACLE_ORDER_ID'),

    defaultFeeBps,
    // 24 hours. Long enough that a wrong resolution can be noticed by somebody who was asleep, and
    // short enough that a correct one does not feel like a withheld payment.
    defaultDisputeWindowSeconds: integer(
      source,
      'FORESIGHT_DEFAULT_DISPUTE_WINDOW_SECONDS',
      86_400,
      0,
      30 * 86_400,
    ),

    deploysEnabled: optional(source, 'FORESIGHT_DEPLOYS_ENABLED', 'true') !== 'false',
    minGasPriceWei,
    maxGasPriceWei,
    // The market's creation is around 1.2M gas at 200 optimizer runs; the ceiling is set with room
    // and well under custody's own 8,000,000 limit for a creation.
    deployGasLimit: wei(source, 'FORESIGHT_DEPLOY_GAS_LIMIT', 3_000_000n),
    resolveGasLimit: wei(source, 'FORESIGHT_RESOLVE_GAS_LIMIT', 300_000n),
    stuckMinutes: integer(source, 'FORESIGHT_STUCK_MINUTES', 30, 1, 1_440),

    proposerUrl: optionalOrUndefined(source, 'FORESIGHT_PROPOSER_URL'),
    proposerToken: optionalOrUndefined(source, 'FORESIGHT_PROPOSER_TOKEN'),
    proposerModelId: optionalOrUndefined(source, 'FORESIGHT_PROPOSER_MODEL_ID'),
    searchUrl: optionalOrUndefined(source, 'FORESIGHT_SEARCH_URL'),
    searchToken: optionalOrUndefined(source, 'FORESIGHT_SEARCH_TOKEN'),
    proposerDeadlineMs: integer(source, 'FORESIGHT_PROPOSER_DEADLINE_MS', 30_000, 1_000, 120_000),
    proposerBatchSize: integer(source, 'FORESIGHT_PROPOSER_BATCH_SIZE', 5, 1, 25),

    policyAction: optional(source, 'FORESIGHT_POLICY_ACTION', 'trade.order.place'),
    policyDeadlineMs: integer(source, 'FORESIGHT_POLICY_DEADLINE_MS', 3_000, 100, 30_000),

    leaseMs: integer(source, 'FORESIGHT_LEASE_MS', 60_000, 1_000, 600_000),
    jobPollMs: integer(source, 'FORESIGHT_JOB_POLL_MS', 1_000, 100, 60_000),
    proposeEveryMinutes: integer(source, 'FORESIGHT_PROPOSE_EVERY_MINUTES', 360, 5, 10_080),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it. The message is the one `loadEnv` produced, which by construction never
 * contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
