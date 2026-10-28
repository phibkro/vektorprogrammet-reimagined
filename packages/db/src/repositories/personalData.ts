/**
 * The Layers of the personal data domain (spec 0007b): the consent records, the alumni requests, the legal holds and
 * the store that interprets the catalog (the export, the erasure and the merge) and the nightly run in its two forms: one
 * that changes rows and one that only counts. The records and the
 * requests are tables that the Person root owns, so every write takes the person's token and goes through `Aggregates`.
 */
import {
  AggregateLocks,
  AlumniRequests,
  ConsentKind,
  ConsentRepository,
  LegalHolds,
  PersonId,
  PersonalDataStore,
  RetentionRun,
} from "@vektorprogrammet/domain";
import type {
  FileKey,
  Locked,
  RetentionMode,
  StoredConsent,
} from "@vektorprogrammet/domain";
import { eq } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Match, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import { Drizzle, decodeWith, single } from "../internal/drizzle.ts";
import { alumniCandidates } from "../personalData/activity.ts";
import { personalDataExport } from "../personalData/export.ts";
import { personalDataMerge } from "../personalData/merge.ts";
import { photosOf, releasePhotos } from "../personalData/photos.ts";
import {
  personalDataRetention,
  personalDataRetentionReport,
} from "../personalData/retention.ts";
import { consent, person } from "../schema.ts";

const StoredRow = Schema.Struct({
  givenAt: Schema.DateTimeUtcFromDate,
  kind: ConsentKind,
  personId: PersonId,
  textVersion: Schema.Int,
  withdrawnAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
});

/** The stored row as the domain's record: a record that was not withdrawn has no `withdrawnAt`. */
const asStored = (row: typeof StoredRow.Type): StoredConsent => {
  const { withdrawnAt, ...rest } = row;

  return withdrawnAt === null ? rest : { ...rest, withdrawnAt };
};

const consentColumns = {
  givenAt: consent.givenAt,
  kind: consent.kind,
  personId: consent.personId,
  textVersion: consent.textVersion,
  withdrawnAt: consent.withdrawnAt,
};

export const ConsentRepositoryLive = Layer.effect(
  ConsentRepository,
  Effect.gen(function* ConsentRepositoryLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;
    const decode = decodeWith(StoredRow);

    const of = Effect.fn("ConsentRepository.of")(function* of(
      personId: PersonId
    ) {
      const rows = yield* db
        .select(consentColumns)
        .from(consent)
        .where(eq(consent.personId, personId))
        .pipe(Effect.orDie);

      return Arr.map(yield* Effect.forEach(rows, decode), asStored);
    });

    const ofLocked = Effect.fn("ConsentRepository.ofLocked")(function* ofLocked(
      locked: Locked<"Person">
    ) {
      const rows = yield* aggregates
        .select(locked, roots.Person.owned.consent)
        .pipe(Effect.orDie);

      return Arr.map(yield* Effect.forEach(rows, decode), asStored);
    });

    const record = Effect.fn("ConsentRepository.record")(function* record(
      locked: Locked<"Person">,
      kind: ConsentKind,
      value: Parameters<ConsentRepository["Service"]["record"]>[2]
    ) {
      const stored = {
        givenAt: DateTime.toDateUtc(value.givenAt),
        textVersion: value.textVersion,
        withdrawnAt:
          value.withdrawnAt === undefined
            ? null
            : DateTime.toDateUtc(value.withdrawnAt),
      };

      const rows = yield* aggregates
        .insert(
          locked,
          roots.Person.owned.consent,
          { ...stored, kind },
          {
            action: "replace",
            set: stored,
            target: [consent.personId, consent.kind],
          }
        )
        .pipe(Effect.orDie);

      return asStored(yield* decode(yield* single(rows)));
    });

    return ConsentRepository.of({ of, ofLocked, record });
  })
);

export const AlumniRequestsLive = Layer.effect(
  AlumniRequests,
  Effect.gen(function* AlumniRequestsLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;

    const candidates = Effect.fn("AlumniRequests.candidates")(
      function* candidates(now: DateTime.Utc) {
        const ids = yield* alumniCandidates(db, now);

        return yield* Effect.forEach(ids, (id) =>
          Schema.decodeEffect(PersonId)(id).pipe(Effect.orDie)
        );
      }
    );

    const claim = Effect.fn("AlumniRequests.claim")(function* claim(
      locked: Locked<"Person">,
      engagementEnd: DateTime.Utc,
      requestedAt: DateTime.Utc
    ) {
      const rows = yield* aggregates
        .insert(
          locked,
          roots.Person.owned.alumniRequest,
          {
            engagementEnd: DateTime.toDateUtc(engagementEnd),
            requestedAt: DateTime.toDateUtc(requestedAt),
          },
          { action: "ignore" }
        )
        .pipe(Effect.orDie);

      return rows.length === 1;
    });

    return AlumniRequests.of({ candidates, claim });
  })
);

/**
 * No entity that can be held exists yet: the sources arrive with their entities (spec 0012 adds expense claims). Each
 * is one more layer that provides `LegalHolds`, so a hold cannot be forgotten by the erasure.
 */
export const LegalHoldsLive = Layer.succeed(
  LegalHolds,
  LegalHolds.of({ of: () => Effect.succeed([]) })
);

export const PersonalDataStoreLive = Layer.effect(
  PersonalDataStore,
  Effect.gen(function* PersonalDataStoreLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;
    const locks = yield* AggregateLocks;

    const retention = personalDataRetention({ aggregates, db, locks });

    const { merge } = personalDataMerge({
      aggregates,
      anonymisePerson: retention.anonymisePerson,
      db,
    });

    const setPhoto = Effect.fn("PersonalDataStore.setPhoto")(function* setPhoto(
      locked: Locked<"Person">,
      photo: FileKey | null
    ) {
      const before = yield* photosOf(db, eq(person.id, locked.id));

      yield* aggregates
        .updateRoot(locked, roots.Person, { photoKey: photo })
        .pipe(Effect.orDie);

      // A key that the person still shows is not released: the statement leaves a file that a person shows alone.
      return yield* releasePhotos(db, before, yield* DateTime.now);
    });

    return PersonalDataStore.of({
      erase: retention.erase,
      exportOf: personalDataExport(db),
      merge,
      setPhoto,
    });
  })
);

/**
 * The nightly run that deletes and anonymises (mode `Apply`). It is the one layer that gives the run its locks and its
 * writer. It is not exported: `retentionRunLayer` hands it out, and only for a mode that applies (spec 0007b R4).
 */
const RetentionRunApplyLive = Layer.effect(
  RetentionRun,
  Effect.gen(function* RetentionRunApplyLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;
    const locks = yield* AggregateLocks;
    const { expire } = personalDataRetention({ aggregates, db, locks });

    return RetentionRun.of({
      run: (now) =>
        Effect.map(expire(now), (counts) => ({
          counts,
          mode: "Apply" as const,
        })),
    });
  })
);

/** The nightly run that only counts (mode `ReportOnly`). It needs the database and nothing else. */
export const RetentionRunReportLive = Layer.effect(
  RetentionRun,
  Effect.gen(function* RetentionRunReportLive() {
    const db = yield* Drizzle;
    const { expire } = personalDataRetentionReport(db);

    return RetentionRun.of({
      run: (now) =>
        Effect.map(expire(now), (counts) => ({
          counts,
          mode: "ReportOnly" as const,
        })),
    });
  })
);

/** The layer of a mode. A mode that is added has no layer until this says which. */
export const retentionRunLayer = (mode: RetentionMode) =>
  Match.value(mode).pipe(
    Match.when("Apply", () => RetentionRunApplyLive),
    Match.when("ReportOnly", () => RetentionRunReportLive),
    Match.exhaustive
  );
