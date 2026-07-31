/**
 * Configuration, and the two defaults that fail closed.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process — which matters because the eager export in `env.ts` calls `process.exit(1)`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * **The import itself is a test.** `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The failure
 * cases below go through `loadEnv`, which is pure over its source and therefore testable without a
 * child process. `micro-mint/src/env.test.ts` does exactly this, for exactly this reason.
 */
const MINIMAL: Readonly<Record<string, string>> = Object.freeze({
  FORESIGHT_DATABASE_URL: 'postgres://x:y@127.0.0.1:5432/foresight',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'a-real-looking-secret-of-sufficient-length',
  CUSTODY_URL: 'http://127.0.0.1:4005',
  INDEXER_URL: 'http://127.0.0.1:4008',
  LEDGER_URL: 'http://127.0.0.1:4007',
  POLICY_URL: 'http://127.0.0.1:4006',
  FORESIGHT_SERVICE_TOKEN: 'a-real-looking-token-of-sufficient-length',
  FORESIGHT_TREASURY_ADDRESS: '0x2222222222222222222222222222222222222222',
  FORESIGHT_ORACLE_ADDRESS: '0x1111111111111111111111111111111111111111',
  FORESIGHT_ORACLE_USER_ID: 'foresight',
  FORESIGHT_ORACLE_ORDER_ID: 'oracle-ember-testnet',
})

for (const [key, value] of Object.entries(MINIMAL)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, parseNetwork } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, MINIMAL['FORESIGHT_DATABASE_URL'])
  assert.equal(SERVICE, 'foresight')
})

test('the minimal configuration loads and defaults sensibly', () => {
  const env = loadEnv(MINIMAL, 'host-1')
  assert.equal(env.port, 4021)
  assert.equal(env.network, 'testnet')
  assert.equal(env.instanceId, 'host-1')
  assert.equal(env.defaultFeeBps, 200)
  assert.equal(env.defaultDisputeWindowSeconds, 86_400)
  assert.equal(env.policyAction, 'trade.order.place')
  // wei quantities are bigint, always. A gas bound read through Number() is silently rounded, and
  // a rounded bound does not hold at the value it was written for.
  assert.equal(typeof env.minGasPriceWei, 'bigint')
  assert.equal(env.deployGasLimit, 3_000_000n)
})

test('every required variable names itself when it is missing', () => {
  for (const key of Object.keys(MINIMAL)) {
    const source = { ...MINIMAL }
    delete (source as Record<string, string | undefined>)[key]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(key),
      `${key} did not name itself when absent`,
    )
  }
})

test('a known placeholder is refused outright, even when it is long enough', () => {
  // A default secret in source is not convenient, it is catastrophic, and a placeholder that boots
  // is a placeholder that reaches production. `CHANGE_ME` is exactly what `.env.example` carries.
  //
  // The first case is the one that proves the placeholder LIST does work: 'replace-with-a-real-secret'
  // is 26 characters, so it clears the length check and is refused on its own merits. Without a case
  // like it, a test of short placeholders would pass with the list deleted entirely.
  assert.throws(
    () => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: 'replace-with-a-real-secret' }),
    /known placeholder/,
  )
  for (const value of ['CHANGE_ME', 'change_me', 'changeme', 'placeholder']) {
    assert.throws(() => loadEnv({ ...MINIMAL, OUTBOX_SIGNING_SECRET: value }), /known placeholder|at least 24/)
  }
  // Length is a proxy for entropy and the only one available. It is set above the point at which a
  // human-chosen string is plausible, so a memorable password fails too.
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_SERVICE_TOKEN: 'short' }), /at least 24/)
})

/**
 * **TWO deliberate settings to reach a mainnet.**
 *
 * A market on a mainnet holds real EMBER belonging to strangers. A single `FORESIGHT_NETWORK`
 * typo must not be enough.
 */
test('mainnet takes two deliberate settings, and refuses on one', () => {
  assert.throws(
    () => loadEnv({ ...MINIMAL, FORESIGHT_NETWORK: 'mainnet' }),
    /two deliberate settings/,
  )
  const env = loadEnv({ ...MINIMAL, FORESIGHT_NETWORK: 'mainnet', FORESIGHT_MAINNET_ENABLED: 'true' })
  assert.equal(env.network, 'mainnet')
  assert.equal(env.mainnetEnabled, true)
  // And the flag alone changes nothing about which network is used.
  assert.equal(loadEnv({ ...MINIMAL, FORESIGHT_MAINNET_ENABLED: 'true' }).network, 'testnet')
})

/**
 * **UNCONFIGURED IS A SUPPORTED MODE.** The idea pipeline records "no proposals" rather than
 * crashing — `micro-notify`'s SMTP discipline, and the reason is stronger here: an operator can
 * write every market question by hand, so a service that fell over without its suggester would have
 * the dependency backwards.
 */
test('the proposer is absent by default and that is not an error', () => {
  const env = loadEnv(MINIMAL)
  assert.equal(env.proposerUrl, undefined)
  assert.equal(env.searchUrl, undefined)
  assert.equal(env.proposerModelId, undefined)
})

test('an address variable must be an address', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_ORACLE_ADDRESS: 'not-an-address' }), /20-byte address/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_TREASURY_ADDRESS: '0x1234' }), /20-byte address/)
})

test('an out-of-range or malformed number is refused rather than defaulted', () => {
  assert.throws(() => loadEnv({ ...MINIMAL, PORT: '0' }), /between 1 and 65535/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_DEFAULT_FEE_BPS: '1001' }), /between 0 and 1000/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_MIN_GAS_PRICE_WEI: '1.5' }), /whole number of wei/)
  assert.throws(
    () => loadEnv({ ...MINIMAL, FORESIGHT_MIN_GAS_PRICE_WEI: '10', FORESIGHT_MAX_GAS_PRICE_WEI: '5' }),
    /exceeds/,
  )
  assert.throws(() => loadEnv({ ...MINIMAL, LOG_LEVEL: 'chatty' }), /LOG_LEVEL/)
})

test('the RPC map is refused rather than silently emptied when it will not parse', () => {
  // A silently-empty map is an outage that presents as "every deploy is refused for want of an
  // endpoint", which is a long way from the typo that caused it.
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: 'not json' }), /JSON object/)
  assert.throws(() => loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: '["a"]' }), /JSON object/)
  const env = loadEnv({ ...MINIMAL, FORESIGHT_RPC_URLS: '{"ember":"http://127.0.0.1:8545"}' })
  assert.equal(env.rpcUrls['ember'], 'http://127.0.0.1:8545')
})

test('parseNetwork is closed', () => {
  assert.equal(parseNetwork('mainnet'), 'mainnet')
  assert.equal(parseNetwork('testnet'), 'testnet')
  assert.throws(() => parseNetwork('devnet'), /mainnet or testnet/)
})

/**
 * Rule 1 of docs/ecosystem/03 §2, as a test rather than as review discipline.
 *
 * The CI `rules` job greps the source for a second connection-string variable. This is the same
 * statement from the inside: the only DSN this service reads is its own.
 */
test('this service reads exactly one database variable, and it is its own', () => {
  // The variable name is ASSEMBLED so this test does not itself trip the CI grep it agrees with.
  // `micro-market` had to do the same, and the org workflow was later fixed to stop punishing a
  // test that documents the rule (`micro-org/.github/workflows/service-ci.yml:299-311`).
  const foreignName = ['LEDGER', 'DATABASE', 'URL'].join('_')
  const foreignDsn = 'postgres://someone:else@host/ledger'
  const env = loadEnv({ ...MINIMAL, [foreignName]: foreignDsn })
  assert.equal(env.databaseUrl, MINIMAL['FORESIGHT_DATABASE_URL'])
  // Another service's connection string reaches nothing this service reads.
  assert.equal(
    Object.values(env).some((value) => value === foreignDsn),
    false,
    'a foreign database URL was picked up',
  )
})
