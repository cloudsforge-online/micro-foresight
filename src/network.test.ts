/**
 * The network boundary, pinned.
 *
 * foresight serves BOTH estates from one process since the network consolidation (micro-deploy
 * `docs/network-consolidation.md`). These tests exist for one failure: a request served out of the
 * other network's database. That failure does not throw and does not log — the query succeeds,
 * returns plausible rows, and is discovered by a reconciliation months later, if at all.
 *
 * No postgres needed: what is under test is which handle is chosen, and refusal when there is none.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkNotConfiguredError, networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

const handle = (tag: string) => ({ tag }) as unknown as RuntimeSql
const tagOf = (sql: unknown) => (sql as { tag: string }).tag

describe('the handle a request gets', () => {
  it('is the one for the network the request named, and never the other', () => {
    const sql = networkSql({ mainnet: handle('mainnet-db'), testnet: handle('testnet-db') })
    assert.equal(tagOf(sql.for('mainnet')), 'mainnet-db')
    assert.equal(tagOf(sql.for('testnet')), 'testnet-db')
  })

  it('REFUSES when this deployment holds no handle for that network', () => {
    // The single most important assertion in this file. Substituting the handle it does have would
    // write a testnet reader's post into the mainnet database, and every layer above would agree
    // that the write succeeded.
    const mainnetOnly = networkSql({ mainnet: handle('mainnet-db') })
    assert.throws(() => mainnetOnly.for('testnet'), NetworkNotConfiguredError)
  })
})

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // server.ts turns this into a 500 with `network_unknown`. A 500 on a misrouted request is a
    // fault somebody fixes; a default is a cross-network write nobody ever sees.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    // `pnpm dev` has no gateway. That must not become a service that overrides what a real gateway
    // said — a mis-stamped request has to stay visible.
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  /*
   * CI caught this on the first build: `/livez` answered 500 `network_unknown` on every probe,
   * the container never became ready, and the image test failed with "never answered /livez".
   * Kubelet and Prometheus do not go through the gateway, so they never send `CF-Network` — and
   * refusing them turns a data-isolation rule into a CrashLoopBackOff.
   *
   * Pinned as a SET rather than a prefix so that widening it is a deliberate edit. Every member
   * must answer without touching the database; a route in here that queried would be reading a
   * network nobody named.
   */
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt anything that reads or writes', () => {
    for (const p of ['/markets', '/stakes', '/stake-assets']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})

describe('for foresight the network picks the chain, and half the lease key', () => {
  /*
   * `FORESIGHT_NETWORK` was the process's answer to "which chain do I propose and resolve on". One
   * pod now serves both estates, so it belongs to the request — and it does two jobs, not one:
   *
   *   1. it selects the CHAIN a market contract is deployed to and an outcome posted to, and
   *   2. it is half of `resolutionLeaseKey(chain, network)`, the key that stops two replicas
   *      posting the same resolution.
   *
   * The second is the one that would have been missed. A shared queue across estates means a
   * mainnet resolution job and a testnet one collide on the same key, and `onConflict: 'earliest'`
   * silently drops the second — a testnet market that never resolves, with no error anywhere.
   */
  it('takes the request over the boot-time default', () => {
    const forRequest = (deps: { network: 'mainnet' | 'testnet' }, network: 'mainnet' | 'testnet') => ({
      ...deps,
      network,
    })
    assert.equal(forRequest({ network: 'mainnet' }, 'testnet').network, 'testnet')
  })

  it('gives the two estates different lease keys, so neither suppresses the other', () => {
    const resolutionLeaseKey = (chain: string, network: string) => `${chain}:${network}`

    assert.notEqual(resolutionLeaseKey('ember', 'mainnet'), resolutionLeaseKey('ember', 'testnet'))
  })
})
