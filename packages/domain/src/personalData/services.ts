/**
 * What the personal data commands need from the store (spec 0007b). `packages/db` implements these over the catalog.
 * Every method that writes a table a person owns takes the person's `Locked` token (spec 0006b) and runs inside the
 * command's transaction (`InTransaction`); `exportOf` is one statement, so it needs neither.
 */
import { Context, Schema } from "effect";
import type { DateTime, Effect } from "effect";

import type { Locked } from "../shared/aggregate.ts";
import type { Conflict } from "../shared/errors.ts";
import type { FileKey, PersonId } from "../shared/ids.ts";
import type { InTransaction } from "../shared/transaction.ts";
import type { ConsentRecord, StoredConsent } from "./consents.ts";
import type { ConsentKind } from "./declaration.ts";

/** Integer counts per table: what a run, an erasure or a merge changed. Never a value. */
export const Counts = Schema.Record(Schema.String, Schema.Int);

export type Counts = typeof Counts.Type;

/**
 * What a nightly retention run does (spec 0007b R4). `Apply` deletes and anonymises what has expired. `ReportOnly`
 * changes nothing and counts what `Apply` would have changed.
 */
export const RetentionMode = Schema.Literals(["Apply", "ReportOnly"]);

export type RetentionMode = typeof RetentionMode.Type;

/** What a run did and in which mode: rows changed (`Apply`), or rows that would have been changed (`ReportOnly`). */
export const RetentionOutcome = Schema.Struct({
  counts: Counts,
  mode: RetentionMode,
});

export type RetentionOutcome = typeof RetentionOutcome.Type;

/** Everything held about one person, as JSON: the rows of each table that names them, by table. */
export const PersonExport = Schema.Struct({
  exportedAt: Schema.DateTimeUtc,
  personId: Schema.Int,
  tables: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Record(Schema.String, Schema.Json))
  ),
});

export type PersonExport = typeof PersonExport.Type;

export class ConsentRepository extends Context.Service<
  ConsentRepository,
  {
    /** The person's records, for display (Min side, the answer page): a read that locks nothing. */
    readonly of: (
      personId: PersonId
    ) => Effect.Effect<readonly StoredConsent[]>;
    /** The locked person's records: a decision read, which runs after the lock. */
    readonly ofLocked: (
      locked: Locked<"Person">
    ) => Effect.Effect<readonly StoredConsent[]>;
    /** Replaces the locked person's record of this kind: one record per person and kind. */
    readonly record: (
      locked: Locked<"Person">,
      kind: ConsentKind,
      record: ConsentRecord
    ) => Effect.Effect<StoredConsent>;
  }
>()("@vektorprogrammet/domain/personalData/ConsentRepository") {}

export class AlumniRequests extends Context.Service<
  AlumniRequests,
  {
    /**
     * People who may be due a request at `now`: not anonymised or merged, at least one membership and none that ends
     * after `now`, their core's first year not over, and no request yet for the end of their last membership. A read
     * that finds whom to lock; the command decides again through the lock.
     */
    readonly candidates: (
      now: DateTime.Utc
    ) => Effect.Effect<readonly PersonId[]>;
    /** One request per person and engagement end: `true` for the call that made it, `false` after. */
    readonly claim: (
      locked: Locked<"Person">,
      engagementEnd: DateTime.Utc,
      requestedAt: DateTime.Utc
    ) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/domain/personalData/AlumniRequests") {}

/** A reason that the person's data stays, and until when. */
export interface Hold {
  readonly source: string;
  readonly reason: string;
  /** When the hold ends, `null` while it has no date. */
  readonly until: DateTime.Utc | null;
  /** `true`: erasure is refused while it holds. `false`: erasure goes ahead and the held rows stay. */
  readonly blocks: boolean;
}

/**
 * The legal holds on a person's data: an open expense claim blocks erasure, a claim that accounting retention keeps
 * stays and is reported with its end date (spec 0007b, falsifier 4). One source per entity that can be held, added with
 * the entity (spec 0012 adds claims). The last Active administrator is not a hold: it is a rule of the admin list.
 */
export class LegalHolds extends Context.Service<
  LegalHolds,
  {
    readonly of: (
      locked: Locked<"Person">,
      now: DateTime.Utc
    ) => Effect.Effect<readonly Hold[], never, InTransaction>;
  }
>()("@vektorprogrammet/domain/personalData/LegalHolds") {}

/** The operations of the catalog that the commands run: `packages/db` interprets the declarations. */
export class PersonalDataStore extends Context.Service<
  PersonalDataStore,
  {
    /** One snapshot of every row that names the person, as JSON (the export). */
    readonly exportOf: (
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect.Effect<PersonExport>;
    /**
     * The early expiry of the locked person's data: for each table that declares `Expire`, the `onExpiry` it declares,
     * now, for this person; the rows of a table that declares `Kept` stay. A second call changes nothing.
     */
    readonly erase: (
      locked: Locked<"Person">
    ) => Effect.Effect<Counts, never, InTransaction>;
    /**
     * Moves every row of `from` to `into`, by the merge rules of the catalog, and makes `from` a tombstone. Both are
     * locked, and so is the admin list. A person that has a row where only one may, or a moved row that a constraint
     * refuses, is a `Conflict` and nothing changes.
     */
    readonly merge: (
      into: Locked<"Person">,
      from: Locked<"Person">
    ) => Effect.Effect<Counts, Conflict, InTransaction>;
    /** Sets (or clears) the locked person's photo, and removes a cleared photo's file when nothing else uses it. */
    readonly setPhoto: (
      locked: Locked<"Person">,
      photo: FileKey | null
    ) => Effect.Effect<void, never, InTransaction>;
  }
>()("@vektorprogrammet/domain/personalData/PersonalDataStore") {}

/**
 * The nightly retention run, apart from the store: the one place that deletes or anonymises by the clock. Its layer
 * fixes the mode, so a program that runs it cannot choose one (spec 0007b R4). The cron selects its layer from the
 * deployment and the approval of the periods. Ordinary database layers provide the report-only implementation.
 */
export class RetentionRun extends Context.Service<
  RetentionRun,
  {
    /**
     * Every rule of the catalog at `now`. In `Apply` it reads who has an expired row, locks them all in ascending
     * order, writes through the tokens, and runs the rows that no one owns as conditional bulk statements. In
     * `ReportOnly` it makes the same selections as counts: it takes no lock and writes nothing.
     */
    readonly run: (
      now: DateTime.Utc
    ) => Effect.Effect<RetentionOutcome, never, InTransaction>;
  }
>()("@vektorprogrammet/domain/personalData/RetentionRun") {}
