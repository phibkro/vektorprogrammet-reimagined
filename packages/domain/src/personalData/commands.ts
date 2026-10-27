/**
 * The handlers of `PersonalDataRpc` (spec 0007b). Each is built with `PersonalDataDomain.handle`, so the grant table
 * has answered before it runs. A command about one person locks the person first (`AggregateLocks`, spec 0006b), reads
 * through the token and writes through it; erasure and merge lock the admin list before any person, because they remove
 * or move an account and the places that decide who the Active administrators are (spec 0006b R2).
 */
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Record as Rec,
} from "effect";
import type { Rpc } from "effect/rpc";

import { codeResource, personOf, runWithCode } from "../accounts/principal.ts";
import { AccountRepository } from "../accounts/services.ts";
import { recordAudit } from "../audit/auditLog.ts";
import type { AuditAction } from "../audit/auditLog.ts";
import { PublicFileRepository } from "../files/services.ts";
import * as Commands from "../kernel/commands.ts";
import type { Principal } from "../kernel/principal.ts";
import { AggregateLocks, lockAdminList } from "../shared/aggregate.ts";
import { Conflict, validationFailed } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import { Outbox, OutboxMessage } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import { personResource } from "../teams/personResource.ts";
import { MembershipRepository, PersonRepository } from "../teams/services.ts";
import { leftAt, stillAsked } from "./alumni.ts";
import {
  answerOf,
  answerRecord,
  consentSummary,
  isCurrent,
  recordOf,
} from "./consents.ts";
import type { AlumniBox, StoredConsent } from "./consents.ts";
import type { ConsentKind } from "./declaration.ts";
import {
  PersonalDataDomain,
  PersonalDataRpc,
  answerAlumniConsent,
  erasePerson,
  exportMyData,
  mergePersons,
  runRetention,
  sendAlumniConsent,
  setAlumniConsent,
  setPhoto,
} from "./rpc.ts";
import {
  AlumniRequests,
  ConsentRepository,
  LegalHolds,
  PersonalDataStore,
  RetentionRun,
} from "./services.ts";
import type { RetentionMode } from "./services.ts";
import { consentTexts } from "./texts.ts";

const LAST_ADMIN =
  "Den siste administratoren med aktiv konto kan ikke slettes. Gi en annen person administratorplassen først.";

const NO_CONSENT =
  "Et bilde krever samtykke fra personen selv. Personen må gi samtykket på Min side.";

const SAME_PERSON = "Velg to forskjellige personer.";

const GONE =
  "En av personene finnes ikke, eller er allerede slått sammen med en annen.";

/**
 * How the audit log names a retention run, by what it did. A run that only counted never says that it ran: its counts
 * are rows that it would have changed (spec 0007b R4). A record over the modes, so a new mode needs its action.
 */
const AUDITED_AS: Readonly<Record<RetentionMode, AuditAction>> = {
  Apply: "retention.ran",
  ReportOnly: "retention.reported",
};

/**
 * `Self` is the only grant that spec 0007b R1 gives `setAlumniConsent` and `exportMyData`, but the kernel's one `Admin`
 * row names every command that a person may run, at scope `all`, so the grant table alone lets an administrator answer
 * for someone else (a current `keepDetails` makes the organisation keep the person's core longer: R3 item 27) or
 * download someone else's whole record. A consent is the person's own statement (GDPR Art. 7(1)), and no grant row can
 * say "only themself" for an administrator, so these two handlers refuse every principal that is not the person, as
 * `setPhoto` does for the consent that a photo needs.
 */
const onlyThePerson = (
  principal: Principal,
  personId: PersonId,
  command: "exportMyData" | "setAlumniConsent"
) =>
  personOf(principal) === personId
    ? Effect.void
    : Effect.fail(PersonalDataDomain.forbidden(command));

/** A record already says what this answer says, for the text that is current: nothing to write. */
const alreadyAnswered = (
  previous: StoredConsent | undefined,
  kind: ConsentKind,
  given: boolean
): boolean =>
  previous !== undefined &&
  isCurrent(previous) === given &&
  previous.textVersion === consentTexts[kind].version;

/**
 * The one path that answers the alumni boxes: Min side (`setAlumniConsent`) and the code of the e-mail
 * (`answerAlumniConsent`) both call it. The person is locked first and the answers decided through the token; an answer
 * that the record already holds writes nothing, so clicking twice leaves the first time on the record.
 */
const recordAnswers = Effect.fn("PersonalData.recordAnswers")(
  function* recordAnswers(
    principal: Principal,
    personId: PersonId,
    answers: Readonly<Partial<Record<AlumniBox, boolean | undefined>>>
  ) {
    yield* InTransaction;
    const consents = yield* ConsentRepository;
    const locked = yield* (yield* AggregateLocks).lock("Person", personId);
    const now = yield* DateTime.now;
    const before = yield* consents.ofLocked(locked);

    yield* Effect.forEach(["keepDetails", "news"] as const, (kind) =>
      Effect.gen(function* answerBox() {
        const given = answers[kind];

        if (
          given === undefined ||
          alreadyAnswered(recordOf(before, kind), kind, given)
        ) {
          return;
        }

        yield* consents.record(
          locked,
          kind,
          answerRecord(kind, given, now, recordOf(before, kind))
        );

        yield* recordAudit(
          principal,
          given ? "consent.given" : "consent.withdrawn",
          "Consent",
          `${personId}:${kind}`
        );
      })
    );

    return consentSummary(yield* consents.ofLocked(locked));
  }
);

/**
 * Sets a photo under the person's own consent, or removes it and withdraws the consent. A photo needs a current
 * consent, and only the person can give it (by passing `consent` on their own call): a leader who sets the photo of
 * someone who has not consented is refused.
 */
const setThePhoto = Effect.fn("PersonalData.setPhoto")(function* setThePhoto(
  principal: Principal,
  request: Rpc.Payload<typeof setPhoto>
) {
  yield* InTransaction;
  const consents = yield* ConsentRepository;
  const store = yield* PersonalDataStore;
  const { personId, photo } = request;
  const locked = yield* (yield* AggregateLocks).lock("Person", personId);
  const now = yield* DateTime.now;

  if (photo === null) {
    const previous = recordOf(yield* consents.ofLocked(locked), "photo");

    yield* consents.record(
      locked,
      "photo",
      answerRecord("photo", false, now, previous)
    );
    yield* store.setPhoto(locked, null);
    yield* recordAudit(principal, "person.photoRemoved", "Person", personId);

    return yield* Effect.void;
  }

  const file = yield* (yield* PublicFileRepository).findByKey(photo);

  if (Option.isNone(file)) {
    return yield* validationFailed(["photo"], `Filen ${photo} finnes ikke.`);
  }

  const current = answerOf(recordOf(yield* consents.ofLocked(locked), "photo"));

  const asksForIt =
    personOf(principal) === personId && request.consent === true;

  if (current !== "yes" && !asksForIt) {
    return yield* new Conflict({
      entity: "Person",
      key: String(personId),
      message: NO_CONSENT,
    });
  }

  if (current !== "yes") {
    yield* consents.record(locked, "photo", answerRecord("photo", true, now));

    yield* recordAudit(
      principal,
      "consent.given",
      "Consent",
      `${personId}:photo`
    );
  }

  yield* store.setPhoto(locked, photo);
  yield* recordAudit(principal, "person.photoSet", "Person", personId);

  return yield* Effect.void;
});

export const PersonalDataHandlers = PersonalDataRpc.toLayer({
  answerAlumniConsent: PersonalDataDomain.handle(answerAlumniConsent, {
    resource: () => codeResource,
    run: ({ keepDetails, news }, principal) =>
      Effect.gen(function* answerWithCode() {
        const personId = personOf(principal);

        if (personId === null) {
          return yield* Effect.die("an alumni answer needs a code principal");
        }

        return yield* recordAnswers(principal, personId, { keepDetails, news });
      }),
  }),
  erasePerson: PersonalDataDomain.handle(erasePerson, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* erasePersonData() {
        yield* InTransaction;
        const accounts = yield* AccountRepository;
        const holds = yield* LegalHolds;
        const store = yield* PersonalDataStore;
        // Erasing deletes an account, so it can remove the last Active administrator: the list's lock comes first.
        const adminList = yield* lockAdminList;
        const locked = yield* (yield* AggregateLocks).lock("Person", personId);
        const now = yield* DateTime.now;

        if (yield* accounts.isLastActiveAdmin(adminList, personId, now)) {
          return yield* new Conflict({
            entity: "Person",
            key: String(personId),
            message: LAST_ADMIN,
          });
        }

        const held = yield* holds.of(locked, now);
        const blocking = Arr.filter(held, (hold) => hold.blocks);

        if (Arr.isReadonlyArrayNonEmpty(blocking)) {
          return yield* new Conflict({
            entity: "Person",
            key: String(personId),
            message: Arr.join(
              Arr.map(blocking, (hold) => hold.reason),
              " "
            ),
          });
        }

        const counts = yield* store.erase(locked);
        const erased = Arr.some(Rec.values(counts), (count) => count > 0);

        if (erased) {
          yield* recordAudit(principal, "person.erased", "Person", personId);
        }

        return {
          erased,
          held: Arr.map(held, ({ reason, source, until }) => ({
            reason,
            source,
            until,
          })),
        };
      }),
  }),
  exportMyData: PersonalDataDomain.handle(exportMyData, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ personId }, principal) =>
      Effect.gen(function* exportPersonData() {
        yield* onlyThePerson(principal, personId, "exportMyData");
        yield* InTransaction;
        // The person must exist: an export of nobody is not an empty file.
        yield* (yield* PersonRepository).findById(personId);
        const now = yield* DateTime.now;

        const exported = yield* (yield* PersonalDataStore).exportOf(
          personId,
          now
        );

        yield* recordAudit(principal, "person.exported", "Person", personId);

        return exported;
      }),
  }),
  mergePersons: PersonalDataDomain.handle(mergePersons, {
    resource: () => Effect.succeed({}),
    run: ({ from, into }, principal) =>
      Effect.gen(function* mergeTwoPersons() {
        yield* InTransaction;

        if (from === into) {
          return yield* validationFailed(["from"], SAME_PERSON);
        }

        const store = yield* PersonalDataStore;
        // A merge moves accounts and admin places, so the list is locked first, then both people in one lockAll.
        yield* lockAdminList;

        const tokens = yield* (yield* AggregateLocks)
          .lockAll("Person", [into, from])
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(
                new Conflict({
                  entity: "Person",
                  key: `${into}:${from}`,
                  message: GONE,
                })
              )
            )
          );

        const tokenInto = Arr.findFirst(tokens, (token) => token.id === into);
        const tokenFrom = Arr.findFirst(tokens, (token) => token.id === from);

        if (Option.isNone(tokenInto) || Option.isNone(tokenFrom)) {
          return yield* Effect.die(
            "lockAll returned no token for a requested person"
          );
        }

        const counts = yield* store.merge(tokenInto.value, tokenFrom.value);
        yield* recordAudit(principal, "person.merged", "Person", into);

        return { counts, into };
      }),
  }),
  runRetention: PersonalDataDomain.handle(runRetention, {
    resource: () => Effect.succeed({}),
    run: (_payload, principal) =>
      Effect.gen(function* runRetentionJob() {
        yield* InTransaction;
        const now = yield* DateTime.now;
        const outcome = yield* (yield* RetentionRun).run(now);

        yield* recordAudit(
          principal,
          AUDITED_AS[outcome.mode],
          "Retention",
          DateTime.formatIso(now),
          outcome.counts
        );

        return outcome;
      }),
  }),
  sendAlumniConsent: PersonalDataDomain.handle(sendAlumniConsent, {
    resource: () => Effect.succeed({}),
    run: (_payload, principal) =>
      Effect.gen(function* sendAlumniRequests() {
        yield* InTransaction;
        const requests = yield* AlumniRequests;
        const memberships = yield* MembershipRepository;
        const outbox = yield* Outbox;
        const locks = yield* AggregateLocks;
        const now = yield* DateTime.now;

        // Ascending, so that the locks come in the global order.
        const candidates = Arr.sort(
          yield* requests.candidates(now),
          Order.Number
        );

        const asked = yield* Effect.forEach(candidates, (personId) =>
          Effect.gen(function* askOne() {
            const locked = yield* locks
              .lock("Person", personId)
              .pipe(Effect.option);

            if (Option.isNone(locked)) {
              return 0;
            }

            // The decision is made again through the lock: the candidates were read without it.
            const end = leftAt(
              yield* memberships.listLocked(locked.value),
              now
            );

            if (Option.isNone(end) || !stillAsked(end.value, now)) {
              return 0;
            }

            if (!(yield* requests.claim(locked.value, end.value, now))) {
              return 0;
            }

            yield* outbox.enqueue([
              OutboxMessage.cases.IssueCode.make({
                personId,
                purpose: "alumniConsent",
              }),
            ]);

            yield* recordAudit(
              principal,
              "alumni.requested",
              "Consent",
              personId
            );

            return 1;
          })
        );

        return { sent: Arr.reduce(asked, 0, (total, one) => total + one) };
      }),
  }),
  setAlumniConsent: PersonalDataDomain.handle(setAlumniConsent, {
    resource: ({ personId }) => Effect.succeed({ personId }),
    run: ({ keepDetails, news, personId }, principal) =>
      Effect.gen(function* answerForThePerson() {
        yield* onlyThePerson(principal, personId, "setAlumniConsent");

        return yield* recordAnswers(principal, personId, {
          keepDetails,
          news,
        });
      }),
  }),
  setPhoto: PersonalDataDomain.handle(setPhoto, {
    resource: ({ personId }) =>
      personResource(PersonalDataDomain.authorize, "setPhoto", personId),
    run: (request, principal) => setThePhoto(principal, request),
  }),
});

export const withPersonalData = Commands.inProcess(
  PersonalDataRpc,
  PersonalDataHandlers
);

/**
 * The entry of a server function for each command (`Commands.endpoint`): untrusted input in, the command's own result
 * out. The answer by code runs as the principal that the code opens.
 */
export const PersonalDataEndpoints = {
  answerAlumniConsent: Commands.endpoint(answerAlumniConsent, (payload) =>
    runWithCode(
      PersonalDataDomain,
      "alumniConsent",
      payload.code,
      withPersonalData((client) => client.answerAlumniConsent(payload))
    )
  ),
  erasePerson: Commands.endpoint(erasePerson, (payload) =>
    withPersonalData((client) => client.erasePerson(payload))
  ),
  exportMyData: Commands.endpoint(exportMyData, (payload) =>
    withPersonalData((client) => client.exportMyData(payload))
  ),
  mergePersons: Commands.endpoint(mergePersons, (payload) =>
    withPersonalData((client) => client.mergePersons(payload))
  ),
  setAlumniConsent: Commands.endpoint(setAlumniConsent, (payload) =>
    withPersonalData((client) => client.setAlumniConsent(payload))
  ),
  setPhoto: Commands.endpoint(setPhoto, (payload) =>
    withPersonalData((client) => client.setPhoto(payload))
  ),
};

/** The jobs' entries: `apps/web` provides their `System` principal and runs each in a transaction. */
export const retentionJob = withPersonalData((client) => client.runRetention());

export const alumniConsentJob = withPersonalData((client) =>
  client.sendAlumniConsent()
);
