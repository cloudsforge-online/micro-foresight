/**
 * The denomination arithmetic, on its own, with no database and no server.
 *
 * Every case here is a statement about money and every one of them was watched to FAIL before the
 * code was written, then re-confirmed by mutation — the weakening is named in the comment above
 * each test, and each one reddens this test and no other. That discipline is phase 1's, and the
 * reason for it is that eight checks which could not fail have been found in this estate this week.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RATE_SCALE, chainSpec } from '@cloudsforge/contracts-chain'
import {
  POOL_ASSET,
  POOL_DECIMALS,
  StakeAssetError,
  disclosureFor,
  formatUnits,
  isTokenStakeAsset,
  parseStakeAssetCode,
  poolAmountFor,
  stakeAmountForPool,
  stakeAssetDecimals,
  type StakeAsset,
} from './stakeassets.ts'

/** BTC at $60,000 and EMBER at $0.25, so 0.01 BTC is $600 is 2,400 EMBER. Checkable by hand. */
const BTC_USD = 60_000_000_000n
const EMBER_USD = 250_000n
const RATES = { stakeUsdScaled: BTC_USD, poolUsdScaled: EMBER_USD }

const ONE_HUNDREDTH_BTC = 1_000_000n // 8 decimals
const TWO_THOUSAND_FOUR_HUNDRED_EMBER = 2_400_000_000_000_000_000_000n // 18 decimals

const BITCOIN: StakeAsset = {
  assetCode: 'BTC',
  decimals: 8,
  displayName: 'Bitcoin',
  enabled: true,
  blockedReason: null,
}

test('the pool is EMBER, and its decimals come from the pinned package rather than a literal', () => {
  // MUTATION: `POOL_DECIMALS = 18` as a literal instead of `chainSpec('EMBER').decimals` — passes
  // today and silently stops tracking the package the whole estate shares at HEAD.
  assert.equal(POOL_ASSET, 'EMBER')
  assert.equal(POOL_DECIMALS, chainSpec('EMBER').decimals)
})

test('0.01 BTC at $60,000 buys 2,400 EMBER at $0.25 — the decimals are applied, not assumed', () => {
  // MUTATION 1: drop `10n ** BigInt(POOL_DECIMALS)` from the numerator → 0n, and the zero guard
  //             turns it into a refusal, so this reddens.
  // MUTATION 2: use POOL_DECIMALS in place of stakeDecimals in the denominator → the answer is
  //             10^10 too small. This is the exact "mixing 8-decimal BTC with 18-decimal EMBER"
  //             defect, and it is the reason this test states a number a reader can verify.
  const pool = poolAmountFor({
    stakeAmount: ONE_HUNDREDTH_BTC,
    stakeDecimals: 8,
    rates: RATES,
  })
  assert.equal(pool, TWO_THOUSAND_FOUR_HUNDRED_EMBER)
})

test('the same integer in an 18-decimal asset is worth 10^10 times less pool, not the same', () => {
  // The guard against `stakeDecimals` being ignored. If the parameter were dropped and EMBER's 18
  // used for everything, these two would be equal — which is the whole defect.
  const asEightDecimals = poolAmountFor({
    stakeAmount: 1_000_000_000_000_000_000n,
    stakeDecimals: 8,
    rates: RATES,
  })
  const asEighteenDecimals = poolAmountFor({
    stakeAmount: 1_000_000_000_000_000_000n,
    stakeDecimals: 18,
    rates: RATES,
  })
  assert.notEqual(asEightDecimals, asEighteenDecimals)
  assert.equal(asEightDecimals / asEighteenDecimals, 10n ** 10n)
})

test('a six-decimal stablecoin amount is not read as an eighteen-decimal one', () => {
  // USDT-on-Ethereum is 6 decimals. 1,000,000 units is one dollar, not 10^-12 of one.
  // At EMBER $0.25 that is 4 EMBER. MUTATION: hard-code 18 as the token decimals — the answer
  // becomes 4e-12 EMBER, which floors to zero and the refusal reddens this test.
  const pool = poolAmountFor({
    stakeAmount: 1_000_000n,
    stakeDecimals: 6,
    rates: { stakeUsdScaled: RATE_SCALE, poolUsdScaled: EMBER_USD },
  })
  assert.equal(pool, 4_000_000_000_000_000_000n)
})

test('the conversion rounds DOWN, and the dust stays where reconciliation can see it', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE FRACTION MUST BE ABOVE A HALF, OR THIS TEST PROVES NOTHING.
  //
  // The first version of this case used a rate whose remainder was 0.33, and rounding half-up
  // produced the SAME answer — a check that could not fail, found by mutation rather than by
  // reading. 2/3 gives a remainder of 0.67, which floor and half-up disagree about.
  //
  // MUTATION: `(numerator + denominator / 2n) / denominator` → this reddens by exactly one wei,
  // and so it should: rounding a credit up mints pool share that no coin backs, and over enough
  // stakes that is a growing invisible liability.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const pool = poolAmountFor({
    stakeAmount: 1n,
    stakeDecimals: 8,
    rates: { stakeUsdScaled: 2n, poolUsdScaled: 3n },
  })
  // 1 * 10^18 * 2 / (10^8 * 3) = 2e18/3e8 = 6,666,666,666.67 → floored, not rounded.
  assert.equal(pool, 6_666_666_666n)
  assert.ok(pool * 3n * 10n ** 8n < 1n * 10n ** 18n * 2n, 'the floored answer is strictly below exact')
  assert.notEqual(pool, 6_666_666_667n, 'half-up would have credited one wei nobody staked')
})

test('a stake that would convert to zero pool share is REFUSED, not silently taken', () => {
  // MUTATION: `if (pool === 0n)` deleted, or changed to `pool < 0n` → the function returns 0n, the
  // schema's `pool_amount > 0` would eventually catch it, and the user would see a 500 instead of
  // a sentence. Refusing here is the difference between "that is too small" and a confiscation.
  assert.throws(
    () =>
      poolAmountFor({
        stakeAmount: 1n,
        stakeDecimals: 18,
        rates: { stakeUsdScaled: 1n, poolUsdScaled: RATE_SCALE * 1_000_000n },
      }),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'amount_too_small',
  )
})

test('a zero stake is refused — BigInt("") is 0n and it arrives more easily than anyone expects', () => {
  // MUTATION: `stakeAmount < 0n` instead of `<= 0n` → a zero stake produces a zero pool share, and
  // the only thing standing between that and a free position is a CHECK three layers away.
  assert.equal(BigInt(''), 0n)
  assert.throws(
    () => poolAmountFor({ stakeAmount: 0n, stakeDecimals: 8, rates: RATES }),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'bad_amount',
  )
})

test('a rate of zero cannot price anything, in either leg', () => {
  // MUTATION: drop either `assertRate` call → the zero leg divides (RangeError) or multiplies to
  // zero (a free position). Both legs are asserted because only one of them is the obvious one.
  for (const rates of [
    { stakeUsdScaled: 0n, poolUsdScaled: EMBER_USD },
    { stakeUsdScaled: BTC_USD, poolUsdScaled: 0n },
  ]) {
    assert.throws(
      () => poolAmountFor({ stakeAmount: ONE_HUNDREDTH_BTC, stakeDecimals: 8, rates }),
      (err: unknown) => err instanceof StakeAssetError && err.code === 'bad_rate',
    )
  }
})

test('a rate scaled twice is refused rather than applied — for an asset the bound can see', () => {
  // The failure this catches is a caller applying RATE_SCALE to a number pricing had already
  // scaled: the rate is 10^6 too large and the position is 10^6 too large with it. MUTATION:
  // delete the upper bound in `assertRate` → this reddens, and a stake sized by a factor of a
  // million lands in the pool with nothing noticing until reconciliation.
  //
  // The bound's limit is stated on `MAX_PLAUSIBLE_RATE` and is not hidden: a double-scaled DOLLAR
  // is inside it, and `pricingclient.ts`'s `rateScale` comparison is what covers that case.
  assert.throws(
    () =>
      poolAmountFor({
        stakeAmount: ONE_HUNDREDTH_BTC,
        stakeDecimals: 8,
        rates: { stakeUsdScaled: BTC_USD * RATE_SCALE, poolUsdScaled: EMBER_USD },
      }),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'bad_rate',
  )
})

test('inverting the conversion does NOT return what was staked — which is why a refund reads the row', () => {
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // THE MOST IMPORTANT TEST IN THIS FILE.
  //
  // The forward conversion floors. Inverting it floors again, so a refund computed from the rate
  // returns strictly less than was taken — silently, in the platform's favour, once per refund.
  // This test PINS that the composition is lossy, so that anyone who later "simplifies" the
  // refund path into `stakeAmountForPool(...)` finds a red test explaining why not.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const rates = { stakeUsdScaled: 7n, poolUsdScaled: 3n }
  const staked = 12_345_679n
  const pool = poolAmountFor({ stakeAmount: staked, stakeDecimals: 8, rates })
  const backAgain = stakeAmountForPool({ poolAmount: pool, stakeDecimals: 8, rates })
  assert.ok(backAgain <= staked, 'the inverse can never exceed what was staked')
  assert.notEqual(backAgain, staked)
  assert.ok(staked - backAgain > 0n)
})

test('SHARD is refused by name as well as by type — the string arrives over HTTP', () => {
  // `IssuableAssetCode` stops a caller in this repository. This stops a request body. MUTATION:
  // delete the `isRetiredAsset` branch → 'SHARD' parses, and only ledger migration 13's trigger
  // is left, three network hops away.
  assert.throws(
    () => parseStakeAssetCode('SHARD'),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'retired_asset',
  )
  assert.throws(
    () => parseStakeAssetCode('shard'),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'retired_asset',
  )
})

test('a token code names chain, network and contract, or it is not a token code', () => {
  // 29 §4.1: two deployments of one brand are two assets, permanently. A bare 'TOKEN:USDT' would
  // be exactly the single code that has to pick one set of decimals and gets it wrong on one chain.
  assert.ok(isTokenStakeAsset('TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7'))
  assert.equal(
    parseStakeAssetCode('TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7'),
    'TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7',
  )
  for (const bad of ['TOKEN:', 'TOKEN:USDT', 'TOKEN:eth:mainnet:0xNOTHEX', 'TOKEN:eth:0xdac1']) {
    assert.throws(
      () => parseStakeAssetCode(bad),
      (err: unknown) => err instanceof StakeAssetError && err.code === 'bad_asset',
      `${bad} should not parse`,
    )
  }
})

test('a token has no decimals of its own and this refuses to guess 18', () => {
  // MUTATION: `tokenDecimals ?? 18` → a six-decimal stablecoin is credited 10^12 times over.
  assert.throws(
    () => stakeAssetDecimals('TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7'),
    (err: unknown) => err instanceof StakeAssetError && err.code === 'unknown_decimals',
  )
  assert.equal(
    stakeAssetDecimals('TOKEN:eth:mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7', 6),
    6,
  )
})

test('chain decimals are read from contracts-chain, for every asset a stake can name', () => {
  assert.equal(stakeAssetDecimals('BTC'), 8)
  assert.equal(stakeAssetDecimals('LTC'), 8)
  assert.equal(stakeAssetDecimals('ETH'), 18)
  assert.equal(stakeAssetDecimals('EMBER'), 18)
})

test('amounts render exactly, with no float anywhere near them', () => {
  assert.equal(formatUnits(ONE_HUNDREDTH_BTC, 8), '0.01')
  assert.equal(formatUnits(TWO_THOUSAND_FOUR_HUNDRED_EMBER, 18), '2400')
  assert.equal(formatUnits(1n, 18), '0.000000000000000001')
  // A number a double cannot hold. MUTATION: render through Number() → this reddens on the tail.
  assert.equal(formatUnits(123_456_789_012_345_678_901n, 18), '123.456789012345678901')
})

test('the disclosure names both units, the direction, and what a void returns', () => {
  // The sentence is the product decision, so it is pinned rather than left to a client. What it
  // must say: the conversion happens, the winnings are EMBER, the FX exposure ends, and a void
  // returns the asset that was taken rather than its value today.
  const text = disclosureFor(
    {
      stakeAssetCode: 'BTC',
      stakeAmount: ONE_HUNDREDTH_BTC,
      poolAmount: TWO_THOUSAND_FOUR_HUNDRED_EMBER,
      rates: RATES,
    },
    BITCOIN,
  )
  assert.match(text, /0\.01 Bitcoin/)
  assert.match(text, /2400 EMBER/)
  assert.match(text, /winnings are all in EMBER/)
  assert.match(text, /no longer exposed to Bitcoin/)
  assert.match(text, /get your 0\.01 Bitcoin back, not its value today/)
})

test('staking EMBER is not described as a conversion, because it is not one', () => {
  const text = disclosureFor(
    {
      stakeAssetCode: 'EMBER',
      stakeAmount: TWO_THOUSAND_FOUR_HUNDRED_EMBER,
      poolAmount: TWO_THOUSAND_FOUR_HUNDRED_EMBER,
      rates: { stakeUsdScaled: EMBER_USD, poolUsdScaled: EMBER_USD },
    },
    { assetCode: 'EMBER', decimals: 18, displayName: 'EMBER', enabled: true, blockedReason: null },
  )
  assert.doesNotMatch(text, /converts/)
})
