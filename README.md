# micro-foresight

Forge Foresight: a **parimutuel prediction market native to Hearth**.

Markets on future events, staked and settled in EMBER **on the chain itself**. An idea pipeline
proposes questions with cited sources and an operator approves or discards them; an approved market
is a deployed contract taking stakes until close; resolution is posted on-chain after a dispute
window, and winners are paid from the pool by the contract, not by anybody's database.

Design authority: `docs/ecosystem/19-new-products.md` §2.

---

## The on-chain / off-chain boundary

This is the most important thing in the repository, so it is first.

| On chain, in `ForesightMarket.sol` | Off chain, in this service |
| --- | --- |
| Every stake. Wallet → contract, directly. | The market registry and its lifecycle. |
| The pool, per outcome, in wei. | A **mirror** of that pool, for browsing. |
| The payout arithmetic and every claim. | Notifying people that a market they are in resolved. |
| The settlement fee, taken by the contract. | **Reporting** that fee to `micro-ledger`, afterwards. |
| The outcome, and the dispute window. | Deciding what the outcome is, and asking the oracle to post it. |
| Who may resolve (one custody-held key). | Which questions may exist at all. |

**The service holds no money, and there is no code path by which it could.** It has no key. A stake
goes wallet → contract; `POST /markets/:id/stake-intent` hands a wallet the contract address, the
calldata and a policy verdict, and the wallet signs and sends. This process could be switched off
between that response and the send and the stake would still work.

**The `positions` table is a mirror and nothing more.** Drop it and: every stake is still in the
contract, every winner can still call `claim()`, every payout is unchanged. The only thing lost is
the browsing experience. The moment anything downstream *decides* from that table rather than
*displays* from it, the mirror has become a second ledger — and the whole point is that there is
one.

**Bookkeeping mirrors the chain, never the reverse.** The order is always: the `FeePaid` log is
indexed → a `fee_reports` row exists → a ledger entry is posted. An entry posted first would be a
claim about money that had not moved.

---

## Why parimutuel

Everyone backing an outcome shares one pool. The odds are the pool ratio and nothing else; the
payout is pro-rata out of the total.

Deliberately **no order book, no AMM, no liquidity provisioning** (§2.2). There is no market maker
to be adversely selected, no liquidity to provision, and no impermanent-loss surface — because there
is no inventory anywhere. A CPMM is a v2 decision to be taken with real usage in front of it, not
before.

The consequence a bettor must be shown rather than shielded from: **your odds are not fixed when you
stake.** They are whatever the final pool ratio turns out to be. That is how every racetrack tote in
the world works, and hiding it would be the dishonest part.

Two other decisions that follow from the arithmetic:

- **The fee is taken from the LOSING pool only.** A winner therefore always receives at least their
  own stake back. A fee off the top would mean a market with a 99% favourite pays its winners less
  than they put in, which reads as a bug to every one of them.
- **A market nobody won refunds everybody.** The alternative — the whole pool to the treasury
  because no ticket matched — is a windfall taken from people who were all wrong together.

Binary in v1: YES or NO. Not a limit the arithmetic needs, a limit on what an operator may write. A
binary question with a named source has exactly one right answer at close; a five-way question
invites a resolution argument, and a resolution argument is the failure mode this design exists to
avoid.

---

## The category allowlist

`src/categories.ts`, versioned, in the repository. Changing it is a code review and a deploy — not a
database row an operator can edit at three in the morning, because "which questions may we ask
strangers to bet on" is not an operational parameter. `unit.test.ts` holds a digest of the tables, so
a change that forgets to bump `CATEGORY_VERSION` is a red build.

**An allowlist, not a ban list.** A ban list is a game the operator loses every round: the space of
terrible questions is larger than any list, and the person writing the next one has read the list.

| Category | What it covers | Settles from |
| --- | --- | --- |
| `protocol_network` | Facts a public blockchain records: a block height by a date, a fork activating, a published upgrade shipping. | chain RPC, block explorer, protocol publication |
| `market_prices` | The published price of a publicly traded instrument at a stated time, from a **named** venue. | exchange API, price index, regulator publication |
| `scheduled_public_events` | Whether a publicly scheduled, publicly reported event happens by its stated date. | official announcement, primary source |

They share one property, which is the actual rule: **the resolution is a public fact with a public
record, about a system rather than about a person.**

And three refusals, recorded so a discard is countable rather than free text:

- `named_private_individual` — the subject has not consented, gains nothing, and carries all of the
  reputational cost of strangers pricing their life.
- `death_or_violence` — it pays people to want one.
- `unverifiable_resolution` — a pool settled by opinion is not a prediction market, it is a decision
  somebody makes about other people's money.

The enforcement is **not** a text filter — a regex for "die" would pass "will X still be with us in
June" and fail a market about a protocol being deprecated. The enforcement is that only the three
categories are approvable, and that **a person approves**.

---

## The AI proposes; a person opens

The idea pipeline (a leased job, never a timer) searches the web, asks an external model for
candidate questions with resolution criteria, and stores each with full provenance: **query,
sources, model id, prompt hash, timestamp**. The sources are carried through to the public market
page, so a bettor can see *why* the market exists.

**Nothing a model produces can open a market.** A market is a financial instrument and its
resolution criteria are a contract with strangers; those get authored by someone accountable. This
is enforced in three independent places, and all three have to fail for a machine's proposal to
reach `open`:

1. `server.ts` — `operatorOf()` refuses any principal that is not an admin USER, so a service token
   cannot produce an `operator:` subject at all.
2. `markets.ts` — the state machine refuses `approved` unless the approver matches `operator:%` and
   the idea it came from is itself `approved`.
3. `migrations.ts` — `markets_unapproved_never_opens`, a CHECK constraint, says the same thing to
   anything that reaches the table by any other route: a future second write path, a data fix, a 3am
   `psql` session. The composite foreign key `(idea_id, idea_status)` with `on update cascade` is
   what makes it checkable inside a row — and it also means **un-approving an idea under a live
   market fails**, which is the direction nobody remembers to test.

`markets.test.ts` tests the state machine and then goes *round* it with raw SQL to test the
constraint separately. Testing only the first would leave the constraint unproven, which is the same
as not having it.

The pipeline's external calls sit behind one interface, and **unconfigured is a supported mode**: no
search endpoint and no model endpoint means the pipeline records "no proposals" and the operator
queue stays empty. Nothing crashes and nothing logs an error every six hours for a thing nobody has
set up. An operator can write every market question by hand — `POST /ideas` is the same path — so a
service that fell over without its suggester would have the dependency exactly backwards.

---

## Resolution honesty

The resolution source is **named at open** and hashed into the contract at open. `questiondoc.ts`
serialises the whole market document — question, criteria, source, close time, dispute window, fee —
canonically and length-prefixed, and `keccak256` of that is the contract's immutable `questionHash`.
`GET /markets/:id` returns the canonical document beside the hash, so a reader can recompute it
themselves rather than take the platform's word that the criteria have not been edited.

**A market whose named source is gone at resolution is `void` — refund, whole, no fee.** The
tempting alternative is always available and always in good faith: the exchange has shut down, but
here is another with the same figure, and everyone can see what the answer obviously is. Taking it
once makes the criteria advisory, and criteria that are advisory are criteria the operator chooses
after the fact. The platform loses its fee and the bettors lose nothing, and that asymmetry is the
point — it gives the operator a standing incentive to name sources that will still be there.

---

## The oracle, and why resolution is a contract creation

This is the one surprising thing in the codebase, so it is written down twice — here and on
`ForesightMarket._isOracle`.

The oracle key lives in `micro-custody`, which is a signing **policy** rather than a signing oracle.
An EVM address of purpose `deployer` may sign a zero-value contract CREATION and nothing else
(`custody/src/signing.ts:210-231`). **There is no purpose in custody today whose EVM shape is "call
a contract with calldata"**: `SIGNABLE_PURPOSES` is `{deployer, treasury, deposit}`
(`custody/src/gates.ts:35`), `transfer` requires empty calldata and says in terms that widening it
would turn the key into a signing oracle (`custody/src/signing.ts:239-245`), and
`custody_keys_purpose_ck` will not even store a fourth purpose (`custody/src/migrations.ts:117`).

That refusal is right, and it is not this repository's to overturn. So the oracle acts the only way
custody will let it act: it **creates a one-shot `ForesightResolver`** whose constructor calls
`oracleAct` and which then deploys with no runtime code at all.

The market recognises it exactly, not heuristically. A contract created by an EOA lands at
`keccak256(rlp([sender, nonce]))[12:]`, and only that account can ever produce a contract there, for
any nonce, ever. So `msg.sender == createAddress(oracle, n)` for a nonce the caller supplies is
**exactly as strong** as `msg.sender == oracle`. A wrong nonce derives a different address and the
market reverts. The direct form (`msg.sender == oracle`) is kept and checked first, so a hardware
wallet needs no resolver and no contract change is needed if custody ever gains a call shape.

`contracts.test.ts` asserts the Solidity derivation equals the TypeScript one on a corpus, including
across the `0x7f`/`0x80` boundary where RLP changes shape and a naive implementation is silently
wrong.

---

## Policy fails closed

`micro-market` fails **open** on its policy gate and is right to: a policy outage that stopped every
seller listing would shut the marketplace by somebody else's incident, and an unmoderated listing can
be taken down afterwards.

Neither half of that survives here. A stake is EMBER into a contract with no undo. So this gate is
shaped like `wallet.withdrawal`'s: **if policy cannot be reached, `stake-intent` answers 503 and
hands out nothing.**

Stated honestly, because it should be: this stops the service issuing an intent, not the chain
accepting a stake. Anybody holding EMBER and the market's address can call `stake()` with a wallet,
and nothing here or anywhere can prevent that — a property of building on a public chain. The gate
governs the platform's own front door, which is the route essentially every user takes.

---

## Architecture

- **No `setInterval`.** The idea pipeline, close, resolution, mirror sync and fee reporting are
  leased jobs claimed `FOR UPDATE SKIP LOCKED` via `@cloudsforge/jobs`. Recurrence is a job that
  re-enqueues itself. Two workers are safe, and `jobs.test.ts` proves it with two real runners
  against one real Postgres.
- **The lease key names the contended resource.** `market.deploy` is keyed on the market (each has
  its own custody-minted deployer, so they are genuinely parallel); `resolution.post` is keyed on
  `oracle:<chain>:<network>` (every market on a chain resolves through ONE oracle address, so the
  contended resource is that address's nonce). Getting these backwards is the mistake
  `micro-settlement` documents at length.
- **No broker.** Postgres outbox → signed HTTP → inbox, deduped on `(topic, event_id)`.
- **All money is `bigint`**, and `numeric(78,0)` in the database. There is no float on any path near
  an amount, and `migrations.test.ts` asserts the column types.
- **Idempotency on mutating routes**, fingerprint excluding per-attempt fields — the `correlationId`
  exclusion `micro-wallet` found and `micro-ledger` pinned.
- **`/livez` static, `/readyz` real probes**, hard vs soft split deliberately: Postgres is the only
  hard probe; custody, the indexer, the ledger and policy are soft. The indexer being down means the
  mirror is stale, and a stale mirror is a page that says *as of* — not a reason to leave the
  balancer.
- **Strict TypeScript**, ESM, Node ≥22, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

---

## The contract

`src/contracts/ForesightMarket.sol`, compiled by `scripts/compile-contracts.mjs` into the
**committed** artefact `src/contracts/generated.ts`. CI recompiles and diffs it, so the bytecode this
service deploys cannot drift from the Solidity a reviewer read. `solc` is exact-pinned at `0.8.26`
for exactly that reason, and `evmVersion` is `paris` — `shanghai` would emit `PUSH0`, which Hearth's
EVM does not implement, and the market would be bricked at creation with stakers' money already
promised.

There is **no owner, no admin, no pause, no upgrade path**, and no withdrawal that is not a claim.
The service's addresses appear twice: `oracle`, which can only ever move the market to `Resolved` or
`Void` and can never move a wei to itself, and `treasury`, which is a destination with no rights. A
total compromise of this service cannot take a stake, redirect a payout, or stop a winner claiming.

Invariants proven against executed bytecode in `contracts.test.ts`:

| Invariant | How |
| --- | --- |
| Stake accounting sums exactly, no rounding leak | Awkward wei amounts; `pool[i]`, `total()` and the contract balance all asserted equal to the sum |
| The pool ratio is the odds | `oddsBps` compared against bigint arithmetic on the pools |
| A stake at or after close is impossible | One second before is accepted; the close second itself reverts `Closed()` |
| Resolution before close is impossible | The real oracle, at the right nonce, still reverts |
| Only the oracle key resolves | A stranger direct, a stranger's resolver, and the oracle's resolver claiming a wrong nonce all fail |
| The dispute window is enforced | One second early reverts `DisputeWindowOpen()` |
| A double claim is impossible | The second `claim()` and `claimFor()` both revert `AlreadyClaimed()` |
| Claim after void refunds exactly and wholly | Including a staker who backed both sides; fee is 0 and the contract ends at 0 |
| Fee + payouts + residue == the pool, exactly | Three winners with indivisible shares; residue asserted `< winners` and swept |
| The residue cannot be taken from a winner | `sweepDust()` reverts while any winning wei is unclaimed |

The integer-division residue is released on a **condition, not a clock**: `winningStakeClaimed`
reaching the winning pool means every winning wei has been claimed by whoever staked it, so what is
left is arithmetic. Unclaimed winnings stay claimable for ever and no timer confiscates them.

---

## Running it

```sh
pnpm install
pnpm compile:contracts        # regenerates the committed artefact; CI diffs it
pnpm typecheck
pnpm migrate                  # the one-shot migrator, never the service
pnpm start
```

Tests need a Postgres whose database name contains `test` — the harness truncates every table this
service owns and refuses anything else:

```sh
docker run -d --rm --name foresight-pg \
  -e POSTGRES_USER=foresight -e POSTGRES_PASSWORD=foresight -e POSTGRES_DB=foresight_test \
  -p 55460:5432 postgres:17-alpine
FORESIGHT_TEST_DATABASE_URL=postgres://foresight:foresight@127.0.0.1:55460/foresight_test pnpm test
```

`--test-concurrency=1` is required, not a preference: every database test file truncates this
service's tables between cases, and a `TRUNCATE` takes an `AccessExclusiveLock` that deadlocks
against another file's inserts.

---

## Routes

| | | |
| --- | --- | --- |
| `GET` | `/livez` `/readyz` `/metrics` | Health. `/livez` is static by design. |
| `GET` | `/categories` | The allowlist and the refusals. **Public**: a refusal list behind a token is one nobody can hold the platform to. |
| `GET` | `/markets` | Browse. |
| `GET` | `/markets/:id` | Detail: the pool with its `asOf`, the canonical document and its hash, and the idea's cited sources. |
| `GET` | `/markets/:id/positions/:address` | A mirrored position, with `asOf` repeated. |
| `POST` | `/markets/:id/stake-intent` | Contract address + calldata + policy verdict. **Fails closed.** No money passes through. |
| `GET`/`POST`/`PATCH` | `/ideas`, `/ideas/:id/approve`, `/ideas/:id/discard` | The operator queue. |
| `POST` | `/markets`, `/markets/:id/approve`, `/markets/:id/open` | The lifecycle, operator-only. |
| `POST` | `/markets/:id/deploy` | **202** and a status URL. Reaches no chain. Requires `Idempotency-Key`. |
| `POST` | `/markets/:id/resolve` | **202**. Plans the resolution — and turns it into a `void` if the named source is gone. |
| `POST` | `/markets/:id/void` | Off-chain void, for a market with no contract yet. A deployed market voids through the oracle. |

---

## What is not here, and why

- **`micro-foresight-web` and `micro-foresight-admin-web`** are separate repositories (§2.2). An
  operator UI must not share a bundle with an unauthenticated public page.
- **A CPMM / AMM.** v2, with real usage in front of it.
- **An on-chain dispute court.** That is a governance system, and a governance system is a much
  larger thing to get wrong than a prediction market. The window plus `void` is the whole mechanism:
  a wrong resolution is visible, and the money has not moved yet.
- **Automatic resolution from a scraped figure.** This service checks that the named source is
  *reachable*; whether it says yes or no is a judgement an operator makes and types in, with a
  rationale. A service that scraped a number and settled money on it is a far larger thing to get
  wrong than anything else in this repository.
