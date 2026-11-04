/**
 * Application persistence (spec 0009). An application belongs to the person who applied (spec 0006b): every write takes
 * that person's `Locked` token and so does the read that a decision rests on. The state is a stored machine
 * (`Submitted`, `Withdrawn`), changed only by `Aggregates.apply`.
 */
import {
  AdmissionPeriodId,
  ApplicationId,
  ApplicationRepository,
  ApplicationState,
  Bolk,
  DepartmentId,
  EmailAddress,
  FieldOfStudyId,
  Gender,
  HeardAbout,
  InTransaction,
  NotFound,
  PersonId,
  TeamId,
  Weekday,
} from "@vektorprogrammet/domain";
import type {
  ApplicationDraft,
  ApplicationMachineTransition,
  ApplicationRef,
  ApplicationView,
  Locked,
  Application,
} from "@vektorprogrammet/domain";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots as aggregateRoots } from "../aggregate/declaration.ts";
import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { verified } from "../live.ts";
import { admissionPeriod, application, person } from "../schema.ts";

const { owned } = aggregateRoots.Person;

const StoredApplication = Schema.Struct({
  availableWeekdays: Schema.Array(Weekday),
  bolk: Bolk,
  createdAt: Schema.DateTimeUtcFromDate,
  doublePosition: Schema.Boolean,
  fieldOfStudyId: FieldOfStudyId,
  gender: Schema.NullOr(Gender),
  heardAboutUs: Schema.Array(HeardAbout),
  id: ApplicationId,
  periodId: AdmissionPeriodId,
  personId: PersonId,
  specialNeeds: Schema.NullOr(Schema.String),
  specialNeedsConsentVersion: Schema.NullOr(Schema.Int),
  specialNeedsConsentedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  state: Schema.Literals(["Submitted", "Withdrawn"]),
  teamInterest: Schema.Array(TeamId),
  yearOfStudy: Schema.Int,
});

const StoredView = Schema.Struct({
  application: StoredApplication,
  departmentId: DepartmentId,
  emailVerified: Schema.Boolean,
  personEmail: EmailAddress,
  personName: Schema.String,
});

const StoredRef = Schema.Struct({
  departmentId: DepartmentId,
  id: ApplicationId,
  periodId: AdmissionPeriodId,
  personId: PersonId,
});

const states = {
  Submitted: ApplicationState.cases.Submitted.make({}),
  Withdrawn: ApplicationState.cases.Withdrawn.make({}),
} as const;

const applicationOf = (row: typeof StoredApplication.Type): Application => ({
  bolk: row.bolk,
  createdAt: row.createdAt,
  doublePosition: row.doublePosition,
  fieldOfStudyId: row.fieldOfStudyId,
  gender: row.gender,
  heardAbout: row.heardAboutUs,
  id: row.id,
  periodId: row.periodId,
  personId: row.personId,
  // The table's check keeps the three columns together: all null, or all set.
  specialNeeds:
    row.specialNeeds !== null &&
    row.specialNeedsConsentedAt !== null &&
    row.specialNeedsConsentVersion !== null
      ? {
          consentVersion: row.specialNeedsConsentVersion,
          consentedAt: row.specialNeedsConsentedAt,
          text: row.specialNeeds,
        }
      : null,
  state: states[row.state],
  teamInterest: row.teamInterest,
  weekdays: row.availableWeekdays,
  yearOfStudy: row.yearOfStudy,
});

const CHANGED = "Søknaden ble endret eller kan ikke endres lenger.";

/** The one row that an id selects, or the application's `NotFound`. */
const theOnly = <Row>(rows: readonly Row[], id: ApplicationId) => {
  const [row] = rows;

  return row === undefined
    ? Effect.fail(new NotFound({ entity: "Application", key: String(id) }))
    : Effect.succeed(row);
};

export const ApplicationRepositoryLive = Layer.effect(
  ApplicationRepository,
  Effect.gen(function* ApplicationRepositoryLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;
    const decodeApplication = decodeWith(StoredApplication);
    const decodeView = decodeWith(Schema.Array(StoredView));
    const decodeRef = decodeWith(StoredRef);

    const insert = Effect.fn("ApplicationRepository.insert")(function* insert(
      locked: Locked<"Person">,
      draft: ApplicationDraft
    ) {
      yield* InTransaction;
      const createdAt = yield* DateTime.now;

      const rows = yield* aggregates
        .insert(locked, owned.application, {
          availableWeekdays: [...draft.weekdays],
          bolk: draft.bolk,
          createdAt: DateTime.toDateUtc(createdAt),
          doublePosition: draft.doublePosition,
          fieldOfStudyId: draft.fieldOfStudyId,
          gender: draft.gender,
          heardAboutUs: [...draft.heardAbout],
          periodId: draft.periodId,
          specialNeeds: draft.specialNeeds?.text ?? null,
          specialNeedsConsentVersion:
            draft.specialNeeds?.consentVersion ?? null,
          specialNeedsConsentedAt:
            draft.specialNeeds === null
              ? null
              : DateTime.toDateUtc(draft.specialNeeds.consentedAt),
          state: "Submitted",
          teamInterest: [...draft.teamInterest],
          yearOfStudy: draft.yearOfStudy,
        })
        .pipe(
          Effect.catch((error) => classifySqlFailure(error, String(locked.id)))
        );

      return applicationOf(yield* decodeApplication(rows[0]));
    });

    const find = Effect.fn("ApplicationRepository.find")(function* find(
      id: ApplicationId
    ) {
      const rows = yield* db
        .select({
          departmentId: admissionPeriod.departmentId,
          id: application.id,
          periodId: application.periodId,
          personId: application.personId,
        })
        .from(application)
        .innerJoin(
          admissionPeriod,
          eq(admissionPeriod.id, application.periodId)
        )
        .where(eq(application.id, id))
        .pipe(Effect.orDie);

      return (yield* decodeRef(
        yield* theOnly(rows, id)
      )) satisfies ApplicationRef;
    });

    const findLocked = Effect.fn("ApplicationRepository.findLocked")(
      function* findLocked(locked: Locked<"Person">, id: ApplicationId) {
        const rows = yield* aggregates
          .select(locked, owned.application, eq(application.id, id))
          .pipe(Effect.orDie);

        return applicationOf(
          yield* decodeApplication(yield* theOnly(rows, id))
        );
      }
    );

    const transition = Effect.fn("ApplicationRepository.transition")(
      function* transition(
        locked: Locked<"Person">,
        id: ApplicationId,
        change: ApplicationMachineTransition
      ) {
        const row = yield* aggregates
          .apply(change, locked, {
            entity: "Application",
            key: String(id),
            message: CHANGED,
            owned: owned.application,
            where: eq(application.id, id),
          })
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", (error) =>
              Effect.die(error)
            )
          );

        return applicationOf(yield* decodeApplication(row));
      }
    );

    const existsForAddress = Effect.fn(
      "ApplicationRepository.existsForAddress"
    )(function* existsForAddress(
      periodId: AdmissionPeriodId,
      email: EmailAddress
    ) {
      const rows = yield* db
        .select({ id: application.id })
        .from(application)
        .innerJoin(person, eq(person.id, application.personId))
        .where(and(eq(application.periodId, periodId), eq(person.email, email)))
        .limit(1)
        .pipe(Effect.orDie);

      return rows.length > 0;
    });

    const list = Effect.fn("ApplicationRepository.list")(function* list(
      departmentIds: readonly DepartmentId[] | null
    ) {
      if (departmentIds !== null && Arr.isReadonlyArrayEmpty(departmentIds)) {
        return [];
      }

      const rows = yield* db
        .select({
          application,
          departmentId: admissionPeriod.departmentId,
          emailVerified: person.emailVerified,
          personEmail: person.email,
          personName: person.name,
        })
        .from(application)
        .innerJoin(
          admissionPeriod,
          eq(admissionPeriod.id, application.periodId)
        )
        .innerJoin(person, eq(person.id, application.personId))
        .where(
          departmentIds === null
            ? undefined
            : inArray(admissionPeriod.departmentId, [...departmentIds])
        )
        .orderBy(desc(application.createdAt), desc(application.id))
        .pipe(Effect.orDie);

      return Arr.map(yield* decodeView(rows), (row): ApplicationView => ({
        ...applicationOf(row.application),
        departmentId: row.departmentId,
        emailVerified: row.emailVerified,
        personEmail: row.personEmail,
        personName: row.personName,
      }));
    });

    return yield* verified(
      "ApplicationRepository",
      ApplicationRepository.of({
        existsForAddress,
        find,
        findLocked,
        insert,
        list,
        transition,
      })
    );
  })
);
