/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **Expand/contract is not advice.** A rolling deploy always runs two versions of this service
 * against one schema, so every change is four releases: add a column, deploy code that writes
 * both, backfill, deploy code that reads the new one, then drop the old one.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 5" means. The fix for a wrong migration is always a new migration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR CONSTRAINTS IN HERE ARE THE POINT OF THE FILE. Each makes a specific disaster impossible
 * rather than merely unlikely, and each is enforced a SECOND time in the application code — the
 * beacon discipline (`micro-beacon`'s `gate_decisions_indeterminate_never_promotes`). Two
 * enforcements is not redundancy: the state machine is what gives a caller a good error message,
 * and the constraint is what survives a bug in the state machine, a migration someone ran by hand,
 * and the one-off script an operator wrote at three in the morning.
 *
 *   `markets_unapproved_never_opens`   A market may not leave `draft` unless a PERSON approved it.
 *                                      The AI proposes; a person opens — §2.3.3. The composite
 *                                      foreign key `(idea_id, idea_status)` is what makes this
 *                                      checkable inside a row: it forces the market to carry its
 *                                      idea's approval status, and `on update cascade` keeps the
 *                                      copy honest. Un-approving an idea whose market is open then
 *                                      fails, in the database, which is the direction nobody
 *                                      remembers to test.
 *
 *   `positions_source_uniq`            One `(market, tx_hash, log_index)` is one position row, for
 *                                      ever. A reorg replays the same logs; without this the
 *                                      mirror double-counts a stake and the public page tells a
 *                                      bettor the pool is twice its real size.
 *
 *   `markets_deploy_in_flight_uniq`    One in-flight deploy per (chain, network, deployer). The
 *                                      lease normally enforces it; this is what makes it true
 *                                      anyway when a clock skews past `lease_until`. Taken from
 *                                      `micro-settlement`'s `outbound_in_flight_uniq`, refined to
 *                                      the truly contended resource exactly as that file's own
 *                                      comment prescribes — index and lease key together, never
 *                                      one alone.
 *
 *   `resolutions_in_flight_uniq`       One in-flight oracle broadcast per (chain, network). Here
 *                                      the coarse key is the RIGHT one and is settlement's
 *                                      verbatim: every market on a chain resolves through ONE
 *                                      oracle address, so the contended resource really is that
 *                                      address's nonce, and two workers signing against it would
 *                                      lose a resolution permanently.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs table
    // missing the (kind, key) unique constraint, which silently turns every recurring enqueue into
    // a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );

      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 3,
    name: 'idempotency',
    up: `
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        request_hash text        not null,
        response     jsonb,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 4,
    name: 'ideas',
    up: `
      -- ────────────────────────────────────────────────────────────────────────────────────────
      -- THE PROVENANCE TABLE. A row here is a QUESTION A MACHINE WROTE, and the columns exist so
      -- that an operator approving one can see exactly where it came from: what was searched, what
      -- came back, which model, which prompt, when. §2.3.3 requires all five, and a proposal
      -- missing any of them is not reviewable — it is an assertion.
      -- ────────────────────────────────────────────────────────────────────────────────────────
      create table if not exists ideas (
        id                     uuid        primary key default gen_random_uuid(),

        status                 text        not null default 'proposed',

        question               text        not null,
        resolution_criteria    text        not null,
        category               text        not null,
        category_version       integer     not null,
        resolution_source_kind text        not null,
        resolution_source_ref  text        not null,
        suggested_close_time   timestamptz not null,

        -- Provenance, all of it. Nullable only for an idea an operator typed themselves, which is
        -- the case 'origin' distinguishes.
        origin                 text        not null default 'model',
        search_query           text,
        sources                jsonb       not null default '[]'::jsonb,
        model_id               text,
        prompt_sha256          text,
        proposed_at            timestamptz not null default now(),

        -- Who acted, and when. An operator subject, never a service.
        decided_by             text,
        decided_at             timestamptz,
        decision_note          text,
        refusal_id             text,

        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now(),

        constraint ideas_status_ck check (status in ('proposed','approved','discarded')),
        constraint ideas_origin_ck check (origin in ('model','operator')),

        -- A model-authored idea must carry its provenance. This is the constraint that stops a
        -- future code path storing a proposal with the fields blank and an operator approving
        -- something whose sources nobody can look at.
        constraint ideas_model_has_provenance check (
          origin <> 'model'
          or (model_id is not null and prompt_sha256 is not null and search_query is not null)
        ),

        -- A decision is a person and a time, together or not at all. And the person is an
        -- OPERATOR: 'service:foresight' approving its own proposals is exactly the thing §2.3.3
        -- forbids, and here it does not commit.
        constraint ideas_decision_is_a_person check (
          (status = 'proposed' and decided_by is null and decided_at is null)
          or (status <> 'proposed' and decided_by like 'operator:%' and decided_at is not null)
        ),

        -- A discard says which refusal it was, from the versioned list. Free text would make
        -- "how often do we refuse for X" unanswerable.
        constraint ideas_discard_has_reason check (status <> 'discarded' or refusal_id is not null)
      );

      -- Referenced by the composite foreign key on markets. Redundant with the primary key as an
      -- index, and NOT redundant as a constraint: a composite FK needs a unique constraint on
      -- exactly the columns it names.
      create unique index if not exists ideas_id_status_uniq on ideas (id, status);

      create index if not exists ideas_queue_idx on ideas (proposed_at desc) where status = 'proposed';
    `,
  },
  {
    version: 5,
    name: 'markets',
    up: `
      create table if not exists markets (
        id                     uuid        primary key default gen_random_uuid(),

        -- draft → approved → open → closed → resolved → settled, plus void. §2.2.
        status                 text        not null default 'draft',

        -- The idea this came from, and ITS status, carried here so the constraint below can be
        -- written at all. See the header: 'on update cascade' is what keeps the copy honest, and
        -- it is what makes un-approving an idea under a live market fail.
        idea_id                uuid,
        idea_status            text,

        question               text        not null,
        resolution_criteria    text        not null,
        category               text        not null,
        category_version       integer     not null,
        resolution_source_kind text        not null,
        -- NAMED AT OPEN, and hashed into the contract. See src/questiondoc.ts.
        resolution_source_ref  text        not null,
        question_hash          text        not null,

        close_time             timestamptz not null,
        dispute_window_seconds integer     not null,
        fee_bps                integer     not null,

        chain                  text        not null default 'ember',
        network                text        not null,

        -- Who approved, and when. An operator subject, never a service. This is the other half of
        -- 'the AI proposes; a person opens'.
        approved_by            text,
        approved_at            timestamptz,

        -- The deploy. Shaped exactly like micro-mint's, because the failure it defends against is
        -- the same one: a crash between the broadcast and the write that records it.
        deploy_state           text        not null default 'pending',
        deployer_address       text,
        contract_address       text,
        deploy_nonce           bigint,
        raw_tx                 text,
        deploy_tx_hash         text,
        custody_audit_id       text,
        broadcast_at           timestamptz,
        deploy_attempts        integer     not null default 0,
        deploy_error           text,

        lease_owner            text,
        lease_until            timestamptz,

        opened_at              timestamptz,
        closed_at              timestamptz,
        resolved_at            timestamptz,
        settled_at             timestamptz,
        voided_at              timestamptz,
        void_reason            text,
        outcome                smallint,

        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now(),

        constraint markets_status_ck check (
          status in ('draft','approved','open','closed','resolved','settled','void')
        ),
        constraint markets_deploy_state_ck check (
          deploy_state in ('pending','building','signed','broadcast','deployed','failed')
        ),
        constraint markets_outcome_ck check (outcome is null or outcome in (0,1)),
        constraint markets_fee_bps_ck check (fee_bps >= 0 and fee_bps <= 1000),
        constraint markets_dispute_window_ck check (dispute_window_seconds >= 0),

        constraint markets_idea_fk
          foreign key (idea_id, idea_status) references ideas (id, status) on update cascade,

        -- ──────────────────────────────────────────────────────────────────────────────────────
        -- **AN UNAPPROVED IDEA CAN NEVER REACH 'open'.** The state machine in src/markets.ts says
        -- the same thing and gives a caller a readable 409; this says it to anything that reaches
        -- the table by any other route. Both are required — §2.4, 'a state-machine test *and* a
        -- DB constraint, the beacon discipline'.
        --
        -- Three conditions, and each one is load-bearing:
        --   * 'approved_by like 'operator:%'' — a PERSON. 'service:foresight' does not match, so
        --     the service cannot approve its own proposals however the code is written.
        --   * 'approved_at is not null' — an approval is an act with a time.
        --   * 'idea_status = 'approved'' when there is an idea at all — the machine's proposal was
        --     accepted, not merely present. A market an operator wrote from scratch has no idea and
        --     needs none.
        --
        -- **'void' IS EXEMPT ALONGSIDE 'draft', AND THAT IS NOT A LOOPHOLE.** The rule this
        -- constraint enforces is about what may become STAKEABLE. Void is the opposite of
        -- stakeable: it is the terminal refusal, it takes no money and it refunds whole. Requiring
        -- an approver in order to void a draft would mean a proposal nobody wanted could only be
        -- disposed of by first approving it, which is precisely backwards. The exemption was added
        -- after the constraint fired on correct code — voiding an unapproved draft — and the fix
        -- was to make the rule more precise rather than to weaken the test that caught it. Both
        -- directions are pinned in markets.test.ts: a draft still cannot reach 'open', and it can
        -- now reach 'void'.
        -- ──────────────────────────────────────────────────────────────────────────────────────
        constraint markets_unapproved_never_opens check (
          status in ('draft','void')
          or (
            approved_by like 'operator:%'
            and approved_at is not null
            and (idea_id is null or idea_status = 'approved')
          )
        ),

        -- A market cannot be open without a contract to stake into. The status would otherwise be
        -- an invitation to send money to an address that does not exist.
        constraint markets_open_has_contract check (
          status not in ('open','closed','resolved','settled') or contract_address is not null
        ),

        -- A resolved market says what it resolved to; a void market says why. A terminal state
        -- that explains nothing is a state an operator cannot act on.
        constraint markets_resolved_has_outcome check (
          status not in ('resolved','settled') or (outcome is not null and resolved_at is not null)
        ),
        constraint markets_void_has_reason check (
          status <> 'void' or (void_reason is not null and voided_at is not null)
        ),

        -- Carried from micro-mint: a row that has broadcast must carry the hash it broadcast. The
        -- window in which a transaction is on the wire and its id is nowhere is the window in
        -- which a second contract gets deployed.
        constraint markets_broadcast_has_hash check (broadcast_at is null or deploy_tx_hash is not null),
        constraint markets_signed_has_bytes check (
          deploy_state not in ('signed','broadcast','deployed')
          or (raw_tx is not null and deploy_tx_hash is not null and contract_address is not null)
        ),
        constraint markets_failed_has_reason check (deploy_state <> 'failed' or deploy_error is not null)
      );

      -- One transaction hash belongs to at most one market. If two rows ever claim one deploy, the
      -- second write fails rather than quietly overwriting the evidence of the first.
      create unique index if not exists markets_deploy_tx_hash_uniq
        on markets (deploy_tx_hash) where deploy_tx_hash is not null;

      create unique index if not exists markets_contract_uniq
        on markets (chain, network, contract_address) where contract_address is not null;

      -- See the file header. Settlement's invariant, refined to the resource that is actually
      -- contended here: every market has its OWN deployer address (custody mints one per market
      -- id), so the nonce a signature is built against belongs to that address alone.
      create unique index if not exists markets_deploy_in_flight_uniq
        on markets (chain, network, deployer_address)
        where deploy_state in ('building','signed','broadcast');

      create index if not exists markets_open_idx on markets (close_time)
        where status = 'open';
      create index if not exists markets_deploying_idx on markets (updated_at)
        where deploy_state in ('pending','building','signed','broadcast');
      create index if not exists markets_status_idx on markets (status, created_at desc);

      -- Every lifecycle transition, appended. The status column says where a market is; this says
      -- how it got there and who moved it, which is the question an audit actually asks.
      create table if not exists market_transitions (
        id             bigserial   primary key,
        market_id      uuid        not null references markets (id) on delete cascade,
        from_status    text        not null,
        to_status      text        not null,
        actor          text        not null,
        reason         text,
        correlation_id text,
        at             timestamptz not null default now()
      );

      create index if not exists market_transitions_market_idx on market_transitions (market_id, id);

      -- Evidence, per deploy attempt. Kept even when the deploy eventually succeeds: 'it worked on
      -- the fourth try' is a different operational fact from 'it worked'.
      create table if not exists market_deploy_attempts (
        id        bigserial   primary key,
        market_id uuid        not null references markets (id) on delete cascade,
        attempt   integer     not null,
        outcome   text        not null,
        tx_hash   text,
        detail    text,
        at        timestamptz not null default now()
      );

      create index if not exists market_deploy_attempts_market_idx on market_deploy_attempts (market_id, id);
    `,
  },
  {
    version: 6,
    name: 'positions',
    up: `
      -- ────────────────────────────────────────────────────────────────────────────────────────
      -- THE MIRROR. Every row here is a COPY of a log the chain already holds.
      --
      -- Nothing in this table is authoritative and nothing downstream may treat it as such. It
      -- exists so the public page can show a pool without every visitor making an RPC call, and so
      -- a notification can be sent when a market a bettor is in resolves. If this table is dropped,
      -- every stake is still in the contract and every winner can still claim — §2.3.1.
      -- ────────────────────────────────────────────────────────────────────────────────────────
      create table if not exists positions (
        id           bigserial   primary key,
        market_id    uuid        not null references markets (id) on delete cascade,

        staker       text        not null,
        outcome      smallint    not null,
        -- numeric(78,0), not a float and not text. 2^256 is 78 digits, so this holds any wei
        -- quantity an EVM chain can express and the database enforces the arithmetic. A float
        -- anywhere near an amount is a defect.
        amount       numeric(78,0) not null,

        tx_hash      text        not null,
        log_index    integer     not null,
        block_height bigint      not null,
        block_hash   text        not null,

        -- A reorg does not delete the row, it marks it. Deleting would lose the evidence that this
        -- service once believed a stake existed, which is precisely what an operator investigating
        -- a disputed pool needs to see.
        orphaned     boolean     not null default false,
        seen_at      timestamptz not null default now(),
        orphaned_at  timestamptz,

        constraint positions_outcome_ck check (outcome in (0,1)),
        constraint positions_amount_ck check (amount > 0),
        constraint positions_orphan_has_time check (orphaned = false or orphaned_at is not null)
      );

      -- ──────────────────────────────────────────────────────────────────────────────────────
      -- **THE MIRROR CANNOT DOUBLE-COUNT A STAKE.** A reorg replays blocks, and the indexer will
      -- hand the same log back with the same (tx_hash, log_index). This index means the replay is
      -- an ON CONFLICT rather than a second row, whatever the sync code believes it is doing.
      -- ──────────────────────────────────────────────────────────────────────────────────────
      create unique index if not exists positions_source_uniq
        on positions (market_id, tx_hash, log_index);

      create index if not exists positions_market_staker_idx
        on positions (market_id, staker) where orphaned = false;

      -- How far the mirror has read, per market. 'as of' is a first-class answer here: the public
      -- page must be able to say when it last saw the chain rather than imply it is live.
      create table if not exists mirror_cursors (
        market_id       uuid        primary key references markets (id) on delete cascade,
        last_block      bigint      not null default 0,
        tip_block       bigint,
        synced_at       timestamptz not null default now(),
        last_error      text
      );
    `,
  },
  {
    version: 7,
    name: 'resolutions',
    up: `
      -- The oracle's on-chain post, as a durable row with a lease, shaped like
      -- micro-settlement's outbound transaction because it is the same problem: one address, one
      -- nonce, N workers.
      create table if not exists resolutions (
        id               uuid        primary key default gen_random_uuid(),
        market_id        uuid        not null references markets (id) on delete cascade,

        chain            text        not null,
        network          text        not null,

        -- 0 resolve YES, 1 resolve NO, 2 void. The market contract's own ACTION_ constants.
        action           smallint    not null,
        -- Why this action, in the operator's words or the resolver job's. Carried to the event.
        rationale        text        not null,

        state            text        not null default 'planned',

        oracle_address   text,
        oracle_nonce     bigint,
        resolver_address text,
        raw_tx           text,
        tx_hash          text,
        custody_audit_id text,
        broadcast_at     timestamptz,
        confirmed_at     timestamptz,
        attempts         integer     not null default 0,
        last_error       text,

        lease_owner      text,
        lease_until      timestamptz,

        created_at       timestamptz not null default now(),
        updated_at       timestamptz not null default now(),

        constraint resolutions_action_ck check (action in (0,1,2)),
        constraint resolutions_state_ck check (
          state in ('planned','building','signed','broadcast','confirmed','failed')
        ),
        constraint resolutions_broadcast_has_hash check (broadcast_at is null or tx_hash is not null),
        constraint resolutions_signed_has_bytes check (
          state not in ('signed','broadcast','confirmed') or (raw_tx is not null and tx_hash is not null)
        )
      );

      -- One resolution per market, ever. A second one is a second answer to a question that has
      -- already been answered on chain, and the contract would reject it anyway — but a row that
      -- exists is a job that runs, and a job that runs is gas.
      create unique index if not exists resolutions_market_uniq on resolutions (market_id);

      -- ──────────────────────────────────────────────────────────────────────────────────────
      -- Settlement's invariant, verbatim in shape and coarse on purpose. Every market on a chain
      -- resolves through ONE oracle address, so the contended resource genuinely is that address's
      -- nonce. Two workers past a skewed lease would read one nonce, obtain two signatures, and one
      -- resolution would be lost with the market's winners waiting on it.
      -- ──────────────────────────────────────────────────────────────────────────────────────
      create unique index if not exists resolutions_in_flight_uniq
        on resolutions (chain, network)
        where state in ('building','signed','broadcast');

      create index if not exists resolutions_open_idx
        on resolutions (chain, network, created_at)
        where state in ('planned','building','signed','broadcast');

      create unique index if not exists resolutions_tx_hash_uniq
        on resolutions (tx_hash) where tx_hash is not null;

      -- What the contract took, read from the chain and reported to micro-ledger. Bookkeeping
      -- mirrors the chain, never the reverse — §2.3.1.
      create table if not exists fee_reports (
        id              uuid        primary key default gen_random_uuid(),
        market_id       uuid        not null references markets (id) on delete cascade,
        amount_wei      numeric(78,0) not null,
        treasury        text        not null,
        tx_hash         text        not null,
        log_index       integer     not null,
        block_height    bigint      not null,
        reported_at     timestamptz,
        ledger_entry_id text,
        created_at      timestamptz not null default now(),

        constraint fee_reports_amount_ck check (amount_wei >= 0)
      );

      -- The same dedupe key the mirror uses, for the same reason.
      create unique index if not exists fee_reports_source_uniq on fee_reports (tx_hash, log_index);
      create index if not exists fee_reports_unreported_idx on fee_reports (created_at)
        where reported_at is null;
    `,
  },
]

export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0, and this service is
 * new — there is no frozen `forge-foresight` to inherit from.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'fee_reports',
  'resolutions',
  'mirror_cursors',
  'positions',
  'market_deploy_attempts',
  'market_transitions',
  'markets',
  'ideas',
  'idempotency_keys',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
