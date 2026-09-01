# micro-foresight

[![ci](https://github.com/cloudsforge-online/micro-foresight/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-foresight/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

<!-- absorbed-banner -->
> ## ⚠️ This code no longer deploys as a service. It runs inside `micro-agora`.
>
> Absorbed in wave **M5b**, release **2026.8.105** (2026-08-30) of the estate's service-merge sequence.
>
> **The canonical source is [`micro-agora`](https://github.com/cloudsforge-online/micro-agora)
> at [`src/foresight/`](https://github.com/cloudsforge-online/micro-agora/tree/main/src/foresight).
> Edit there.** What is in this repository is the copy the merge was made from: it is frozen, no
> image is published from it, `cfctl bump` skips it, and nothing in the estate runs it.
>
> **Why the repository still exists.** Its registry row survives as `absorbed(…)`, which is what
> keeps the Kubernetes `Service` of this name resolving — an `ExternalName` alias to `agora`, so
> every caller that addresses it by service name still reaches the code. `deployableRepos()` keeps
> the row and `releasableRepos()` drops it. The history here is also the history of the module.
>
> **What did not change**, and this is the point of the merge rather than an aside: the database is
> still its own, the routes are unchanged except where a collision forced a remount, the migrations
> still run under this module's name, and the trust boundary is unchanged. A merge moved a process
> boundary, not a responsibility.
>
> Everything below describes the domain, and remains accurate. Read the reasoning — including what
> was refused and why — in
> [`micro-deploy/docs/service-merge-plan.md`](https://github.com/cloudsforge-online/micro-deploy/blob/main/docs/service-merge-plan.md).

Forge Foresight: a **parimutuel prediction market native to Hearth**.

Markets on future events, staked and settled in EMBER **on the chain itself**. An idea pipeline
proposes questions with cited sources and an operator approves or discards them; an approved market
is a deployed contract taking stakes until close; resolution is posted on-chain after a dispute
window, and winners are paid from the pool by the contract, not by anybody's database.

Design authority: [`ecosystem/19-new-products.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/19-new-products.md) §2.

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

## `seed/` — questions written by hand, checked by the build

There is no market seed *migration* and there is not going to be one. A market is created through
`POST /markets` by an admin user and approved by a named operator, and a migration that inserted
rows into `markets` would be the fourth write path the three guards above exist to prevent.

What `seed/` holds is the **data**, not the mechanism: `questions-2026h2.mjs` is a dependency-free
ESM module exporting an array in the exact shape `POST /markets` takes, plus `cover` (the style
prompt for generated art) and `observed` (the reading that justified the threshold). It is plain
`.mjs` rather than TypeScript because the estate's seeder is a bare-`node` script with no loader;
`questions-2026h2.d.mts` is what lets this repository's own tests import it under `tsc`.

The reason the data lives *here*, next to the rules, is `src/seedquestions.test.ts`. It runs the
service's own predicates — `isCategory`, `isSourceKindFor`, the numeric bounds `server.ts` enforces,
`questionHash` itself — over every entry, on every push, with no database and no chain. Without it,
a category paired with a source kind it is not allowed is discovered as a 400 by an operator
mid-bootstrap, with some markets created and some not. It does **not** check whether a question is
one the platform should run: that is the allowlist and a person, for the reason two sections up.

The suite also carries a deliberate tripwire. `createDraft` refuses a close time in the past, so an
expired batch is a file that fails per-entry the moment anyone uses it; the build goes red when the
*last* question in a batch closes, and the message says to research a new batch or delete the file.

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
(`custody/src/signing.ts`). **There is no purpose in custody today whose EVM shape is "call
a contract with calldata"**: `SIGNABLE_PURPOSES` is `{deployer, treasury, deposit}`
(`custody/src/gates.ts`), `transfer` requires empty calldata and says in terms that widening it
would turn the key into a signing oracle (`custody/src/signing.ts`), and
`custody_keys_purpose_ck` will not even store a fourth purpose (`custody/src/migrations.ts`).

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
  leased jobs claimed `FOR UPDATE SKIP LOCKED` via `@cloudsforge/jobs`. Two workers are safe, and
  `jobs.test.ts` proves it with two real runners against one real Postgres.
- **Recurrence is a boot seed plus a re-arm on the runner's `completed` event — never a handler
  enqueuing itself.** This line used to read "recurrence is a job that re-enqueues itself", and that
  is what the code did, and it did not work: `enqueue` is `on conflict (kind, key) do nothing`, so a
  self-enqueue landed on the handler's own still-present row, and `JobRunner` then deleted that row
  with `complete()`. Every background job in this service therefore ran **exactly once per boot and
  then never again**, silently — an empty `jobs` table is indistinguishable from a service with
  nothing to do. Found by running it: the table held 0 rows 47 minutes into a live deployment while
  nine sibling services held live ones, and the outbox showed every event's `published_at` landing at
  the timestamp of the *next container boot*. `recurringJobs` in `jobs.ts` is the table,
  `rescheduleRecurring` is the re-arm, and `foresight_jobs_recurring_present` vs
  `…_expected` makes a recurrence that stops visible in one scrape.
- **The two kinds keyed on a market id — `market.deploy` and `mirror.sync` — are driven by sweeps**
  (`deploy.sweep`, `mirror.sweep`), because a fixed re-arm table cannot hold a key that only exists
  once an operator approves something. `deploySweepHandler` had been written and tested for this and
  was never passed to `runner.register`; it is registered now, and a test asserts every declared kind
  has a handler.
- **Service tokens are exchanged, not read once.** `FORESIGHT_IDENTITY_CREDENTIAL` is a long-lived
  `cfsc_…` secret exchanged at `POST /service-tokens/exchange` by `@cloudsforge/auth`'s
  `ServiceTokenProvider`, wired in `src/upstreams.ts`. The old `FORESIGHT_SERVICE_TOKEN` is a
  600-second JWT nothing could renew, and this service's custody calls come from leased jobs — the
  exact shape that froze EMBER reconciliation through `micro-ledger`. It is still accepted, as a
  migration aid, and the boot log says `fatal` when it is all there is. `servicetoken.test.ts` drives
  a real leased job **eleven minutes and then eight hours** past the token's life and asserts it cost
  no 401 at all — a run at minute zero proves nothing here.
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
| `GET` | `/markets/:id` | Detail: the pool with its `asOf`, the canonical document and its hash, the idea's cited sources, and **the house-seed disclosure** whenever one exists. |
| `GET` | `/markets/:id/positions/:address` | A mirrored position, with `asOf` repeated. |
| `POST` | `/markets/:id/stake-intent` | Contract address + calldata + policy verdict. **Fails closed.** No money passes through. |
| `GET`/`POST`/`PATCH` | `/ideas`, `/ideas/:id/approve`, `/ideas/:id/discard` | The operator queue. |
| `POST` | `/markets`, `/markets/:id/approve`, `/markets/:id/open` | The lifecycle, operator-only. `approve` may carry `houseSeedPerOutcomeWei`; `open` refuses a seeded market until the house money is in the pool. |
| `POST` | `/markets/:id/deploy` | **202** and a status URL. Reaches no chain. Requires `Idempotency-Key`. |
| `POST` | `/markets/:id/resolve` | **202**. Plans the resolution — and turns it into a `void` if the named source is gone. |
| `POST` | `/markets/:id/void` | Off-chain void, for a market with no contract yet. A deployed market voids through the oracle. |

---

## The house seed: a disclosed, opinion-free counterparty

> **Operators: the runbook is `deploy/docs/house-seed.md`** (repository `micro-deploy`)
> — where the EMBER comes from, who holds the key and what that exposes, the exact
> configuration on both networks, the numbered procedure with an on-chain verification
> after each step, the caps, what it costs, and how to unwind. Read it before moving
> money. This section explains the design; that document tells you what to do.

A parimutuel market with one bettor is a refund machine — the lone winner splits a pool containing
only their own stake, so nobody's first bet can ever be interesting. `docs/ecosystem/21` decides
the platform may put its own money in first, and §5 gives the shape: **symmetric, at open, never
after, and labelled on the surface where users see it.** Every clause of that sentence is a schema
fact here, not a handler's opinion — migration 8, `src/migrations.ts`:

| The claim (21 §5, §7) | The line that makes it unrepresentable |
| --- | --- |
| The house expresses **no opinion** | `house_seeds_symmetric` — `amount_yes_wei = amount_no_wei`, a CHECK. A lopsided seed does not fail review; it fails to insert (§7.2). |
| A house stake **after open** cannot exist | trigger `house_seeds_only_before_open` — a seed may only be INSERTed while the market is `approved`. Against an `open` market it raises, connection in hand (§7.1). |
| A house stake **carries the market's open timestamp** | trigger `house_seeds_carry_open_timestamp` — `staked` demands the market be `open` and `staked_at` be **equal** to `markets.opened_at`. Equality, not proximity. |
| A recorded stake is **immutable** | same trigger — it is the disclosure the market page shows, so it cannot be edited after the fact. |
| A **half-recorded** stake cannot exist | `house_seeds_staked_is_complete` — state, timestamp and both transaction hashes become true together. |
| Seeds are **bounded** | `house_seeds_within_market_ceiling` (10²¹ wei = 1,000 EMBER per outcome side) and trigger `house_seeds_daily_ceiling` (10²² wei per side per UTC day) — the same numbers `micro-admin-api` CHECKs on the operator policy (§7.3). |

All seven are fire-tested with raw SQL in `src/houseseed.test.ts`, routes bypassed.

**This service still never touches the money, and the seed is not an exception.** The house is an
ordinary bettor with a *published* address (`FORESIGHT_HOUSE_ADDRESS`, disclosed the way the
platform miners' coinbases are — 21 §3). It stakes through the same `stake(uint8)` everyone uses,
its position is mirrored into `positions` like anyone's, the contract's `payoutOf` counts it like
anyone's, and its winnings return through `claim()`/`claimFor()`
(`src/contracts/ForesightMarket.sol`) — so **settlement composes rather than forks**:
there is no house-specific path in resolution, settlement or payout, because the house is not a
special case anywhere on chain.

That is also the only design custody admits, and it is worth stating rather than discovering:
`stake(uint8)` is a value-bearing contract CALL, and custody's three EVM shapes are creation
(value must be zero — `custody/src/signing.ts`), plain value transfer (data must be empty
—) and sweep. None of them can call a contract with value; it is the same constraint
that makes the oracle act through a constructor. So the house key lives outside this estate's
custody, and a seeder *contract* is refused on its own terms: the contract would be the staker,
and its winnings would strand at an address with no key.

**Opening a seeded market is refused until the money is already in the pool.**
`recordHouseStake` compares the plan against the mirror and demands the *exact* symmetric position
from the house address — not at-least, exactly, because an overshoot would make the disclosure
understate the house. So "open, with a seed" is a fact about the pool, never an intention.

**The caps bind twice.** The hard ceilings above hold against anyone with a connection. The
operator-tunable sizes below them live in `micro-admin-api`'s `engagement_policies` (21 §4 puts
cross-service operator state there, and §8 is blunt that *nothing may move before the caps
exist*), and are read at approval time through `src/adminapiclient.ts` — **fail closed**, exactly
like the stake-intent policy gate: an unreadable cap refuses the seed with 503 and a retry hint,
never a default. Plain approval is untouched by that outage, because an unreachable operator
surface must not stop ordinary markets.

**Unconfigured is a supported mode.** With no `FORESIGHT_HOUSE_ADDRESS` or no `ADMIN_API_URL`,
this deployment runs no engagement programme: approving with a seed refuses with a sentence saying
so, and everything else behaves exactly as it did.

**One recorded divergence from the document.** 21 §5 words the disclosure in Shards
(*"CloudsForge seeded this pool with X Shards"*). The pool this seed sits in is EMBER wei on a
public chain, and converting through an administered price would make the disclosed number move
without anybody staking anything. The honest unit is the pool's own, so the served sentence says
EMBER. It is composed once, in `houseSeedView`, and served — never left for each client to
improvise.

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
- **A job that stakes the house seed.** The seed is staked from a wallet the platform controls
  outside this estate's custody (see above), so this service *records and gates* the seed rather
  than sending it. Automating the send would need a custody transaction shape that does not exist
  and should not be widened for this.
- ~~**`foresight-web` rendering the disclosure.**~~ **This has landed** — corrected 2026-08-06,
  because the bullet claimed a gap that no longer exists. `GET /markets/:id` serves the sentence,
  the amounts, the address and the on-chain evidence hashes, and `micro-foresight-web` renders all
  of it above the ratio bar: `foresight-web/src/components/houseseed.tsx`, mounted at
  `foresight-web/src/pages/market.tsx`. The client re-derives symmetry and pool share rather
  than repeating them, and renders a loud alarm if the numbers do not support the sentence. 21
  §7.6's proof is held in full.

### Found while reading, reported not fixed

**Every settlement-fee report this service has ever attempted would have been refused by the
ledger, three ways at once.** Found by re-reading `feePostings` against the ledger's source during
the engagement-treasury wave; corrected here in the same change, because two of the three were
this repository's own:

1. `subject: 'chain:<id>'` was not in the account grammar — `parseAccountSubject` threw inside the
   ledger's `ensureAccount` (`ledger/src/accounts.ts`). **Fixed at the root** in
   `micro-contracts`: the subject was the right one and the grammar now registers it.
2. `purpose: 'clearing'` is a *type*, not a purpose — `accounts_purpose_chk`
   (`ledger/src/migrations.ts`) refuses it. The transit purpose is `suspense`; the type stays
   `clearing`, which is also what lets the account sit either side of zero.
3. `kind: 'foresight.settlement_fee'` was not in the ledger's closed `journal_entries_kind_chk`
   list (`ledger/src/migrations.ts`). The vocabulary is closed precisely so revenue reports
   can count on it; the right name in it is `fee_charged`.

Nothing needed reconciling — there is no public network yet, so no entry had ever posted. The
test asserting the old kind was asserting the defect, and was corrected with it.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
