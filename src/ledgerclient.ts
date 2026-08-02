/**
 * The ledger, for fee reporting only.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOOKKEEPING MIRRORS THE CHAIN, NEVER THE REVERSE** — 19-new-products.md §2.3.1.
 *
 * The fee is taken by the CONTRACT, on settlement, to the treasury address. Nothing in this
 * service authorises it, sizes it or moves it, and no entry posted here can change it by a wei.
 * What this client does is record, for reporting, a transfer that has already happened on a public
 * chain and can be verified by anybody.
 *
 * So the order is always: the `FeePaid` log is indexed → a `fee_reports` row exists → an entry is
 * posted. Never the other way round. An entry posted first would be a claim about money that had
 * not moved, and the reconciliation that caught it would be the ledger's, weeks later.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Route verified against `micro-ledger/src/server.ts`: `POST /entries`, unprefixed.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

export const LEDGER_SCOPES: readonly string[] = Object.freeze(['ledger:post'])

export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface Posting {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: string
  readonly sequence: number
  readonly account: {
    readonly subject: string
    readonly assetCode: string
    readonly purpose: string
    readonly type: string
  }
}

export interface EntryRequest {
  readonly kind: string
  readonly actor: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly Posting[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: EntryRequest): Promise<PostedEntry>
}

/**
 * The two postings a settlement fee produces.
 *
 * The debit side is the market's own pool, which is not an account the ledger holds a balance for —
 * it is a contract on a chain. So it is booked against a clearing account named for the chain, and
 * the credit is platform fee revenue. This is bookkeeping about somebody else's ledger (the chain's)
 * and the clearing account is what makes that honest: it says "this came from outside".
 *
 * ── FOUND DEAD ON ARRIVAL, 2026-08 (the engagement-treasury wave re-read this against the
 * ledger's source). As first shipped, every fee report was refused by the ledger THREE ways:
 *   1. subject `chain:<id>` was not in the account grammar — `parseAccountSubject`
 *      (contracts/packages/money/src/index.ts) threw inside the ledger's `ensureAccount`
 *      (ledger/src/accounts.ts:104). Fixed at the ROOT: the grammar now registers `chain:<id>`,
 *      because the subject was the right one.
 *   2. purpose `'clearing'` is a TYPE, not a purpose — `accounts_purpose_chk`
 *      (ledger/src/migrations.ts:130) refuses it. The transit purpose is `'suspense'`; the type
 *      stays `'clearing'`, which is also what lets the account sit either side of zero
 *      (ledger's overdraft trigger exempts type `clearing`).
 *   3. the entry kind `'foresight.settlement_fee'` was not in the ledger's closed
 *      `journal_entries_kind_chk` list (ledger/src/migrations.ts:181) — the vocabulary is closed
 *      precisely so revenue reports can count on it, and the right name in it is `'fee_charged'`.
 * No entry had ever posted (there is no public network yet), so nothing needed reconciling.
 */
export function feePostings(input: {
  readonly amountWei: bigint
  readonly chain: string
}): readonly Posting[] {
  return [
    {
      account: {
        subject: `chain:${input.chain}`,
        assetCode: 'EMBER',
        purpose: 'suspense',
        type: 'clearing',
      },
      direction: 'debit',
      amount: input.amountWei,
      assetCode: 'EMBER',
      sequence: 0,
    },
    {
      account: { subject: 'platform', assetCode: 'EMBER', purpose: 'fees', type: 'revenue' },
      direction: 'credit',
      amount: input.amountWei,
      assetCode: 'EMBER',
      sequence: 1,
    },
  ]
}

/**
 * The key one market's fee is posted under, for ever.
 *
 * Derived from the market id, not from a timestamp or a counter: the whole value of the key is that
 * a retry after a lost response replays rather than posts a second entry, and a key that changes
 * between attempts provides none of it.
 */
export function feeIdempotencyKey(marketId: string): string {
  return `foresight:fee:${marketId}`
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      try {
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all,
        // because `HttpClient` attempts a non-idempotent method exactly once without one.
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
              // 754 double, and one EMBER is 1e18 wei — an amount does not survive the round trip.
              // It does not fail either; it comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        })
        return {
          id: body.entry.id,
          kind: body.entry.kind,
          recordedAt: body.entry.recordedAt,
          replayed: body.replayed,
        }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the entry
 * posted, and the only safe response is to retry with the same key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
