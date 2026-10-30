/**
 * The handlers of `AdmissionRpc` (spec 0009). Each is built with `AdmissionDomain.handle`, so the grant table has
 * answered before it runs. A public submit and a staff registration make an application through one function, so the
 * checks are the same; a person who applies is created with an address that is not verified, and the mail that follows
 * carries the code that verifies it (`verifyApplicantEmail`, in `personalData`, which merges the person into a known one
 * when the address is already verified: RULE-306).
 */
import { Array as Arr, DateTime, Effect, Option } from "effect";

import { IssueCodeMessage } from "../accounts/messages.ts";
import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import * as Machine from "../kernel/machine.ts";
import {
  admissionState,
  openAdmissionPeriod,
} from "../organisation/admission.ts";
import type { StoredAdmissionPeriod } from "../organisation/admission.ts";
import { currentSemester } from "../organisation/commands.ts";
import { SemesterOrder } from "../organisation/semester.ts";
import {
  AdmissionPeriodRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "../organisation/services.ts";
import { AggregateLocks } from "../shared/aggregate.ts";
import { Conflict, validationFailed } from "../shared/errors.ts";
import type { AdmissionPeriodId, ApplicationId } from "../shared/ids.ts";
import { Outbox } from "../shared/outbox.ts";
import { InTransaction } from "../shared/transaction.ts";
import { PersonRepository, TeamRepository } from "../teams/services.ts";
import {
  AdmissionDomain,
  AdmissionRpc,
  ApplicationMachine,
  createAdmissionPeriod,
  deleteAdmissionPeriod,
  extendAdmissionPeriod,
  registerApplication,
  submitApplication,
  withdrawApplication,
} from "./declaration.ts";
import type { ApplicationReceipt } from "./declaration.ts";
import { specialNeedsConsentText } from "./entities.ts";
import type { ApplicantInput } from "./entities.ts";
import { ApplicationRepository } from "./services.ts";

export const NOT_OPEN = "Opptaket er ikke åpent for denne avdelingen.";

const NOT_THIS_SEMESTER = "Opptaket gjelder ikke inneværende semester.";

const OTHER_DEPARTMENT = "Linjen hører ikke til denne avdelingen.";

const INACTIVE_TEAM = "Velg bare aktive team i avdelingen.";

const ALREADY_APPLIED =
  "Det finnes allerede en søknad fra denne e-postadressen i dette opptaket.";

const ALREADY_WITHDRAWN = "Søknaden kan ikke trekkes. Den er allerede trukket.";

const NO_SEMESTER = "Semesteret finnes ikke ennå.";

const NO_PERIOD = "Opptaket finnes ikke.";

const END_LATER = "Ny slutt må være etter dagens slutt.";

const HAS_ENDED = "Opptaket er avsluttet.";

const MAY_NOT_BE_CANCELLED =
  "Opptaket kan bare avlyses før det har begynt, og uten søknader.";

/**
 * One application, from the input that its schema checked and the period it is for: the field of study and the teams
 * of the period's department (RULE-159, 165), the person who applies, the application, and the mail that verifies the
 * address. The public submit and the staff registration both end here.
 */
const apply = Effect.fn("Admission.apply")(function* apply(
  period: StoredAdmissionPeriod,
  input: ApplicantInput
) {
  yield* InTransaction;

  const field = yield* (yield* FieldOfStudyRepository)
    .findById(input.fieldOfStudyId)
    .pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(validationFailed(["fieldOfStudyId"], OTHER_DEPARTMENT))
      )
    );

  if (field.departmentId !== period.departmentId) {
    return yield* validationFailed(["fieldOfStudyId"], OTHER_DEPARTMENT);
  }

  const activeTeams = Arr.map(
    Arr.filter(
      yield* (yield* TeamRepository).list(period.departmentId),
      (team) => team.active
    ),
    (team) => team.id
  );

  if (
    Arr.some(input.teamInterest, (team) => !Arr.contains(activeTeams, team))
  ) {
    return yield* validationFailed(["teamInterest"], INACTIVE_TEAM);
  }

  const now = yield* DateTime.now;

  // The person is new and no one else can lock it yet; the lock is what the application's write takes.
  const person = yield* (yield* PersonRepository).create({
    email: input.email,
    fieldOfStudyId: input.fieldOfStudyId,
    name: input.name,
  });

  const locked = yield* (yield* AggregateLocks)
    .lock("Person", person.id)
    .pipe(Effect.orDie);

  const application = yield* (yield* ApplicationRepository).insert(locked, {
    bolk: input.bolk,
    doublePosition: input.doublePosition,
    fieldOfStudyId: input.fieldOfStudyId,
    gender: input.gender,
    heardAbout: input.heardAbout,
    periodId: period.id,
    specialNeeds:
      input.specialNeeds === null
        ? null
        : {
            consentVersion: specialNeedsConsentText.version,
            consentedAt: now,
            text: input.specialNeeds,
          },
    teamInterest: input.teamInterest,
    weekdays: input.weekdays,
    yearOfStudy: input.yearOfStudy,
  });

  yield* (yield* Outbox).enqueue([
    IssueCodeMessage.make({
      personId: person.id,
      purpose: "verifyApplication",
    }),
  ]);

  const receipt: ApplicationReceipt = {
    applicationId: application.id,
    departmentId: period.departmentId,
  };

  return receipt;
});

/** What a grant needs of a period: the department that it is for. A period that is not there names none, so no grant holds. */
const grantResourceOfPeriod = (id: AdmissionPeriodId) =>
  Effect.gen(function* periodOfGrant() {
    return yield* (yield* AdmissionPeriodRepository).findById(id).pipe(
      Effect.map((period) => ({ departmentId: period.departmentId })),
      Effect.catchTag("NotFound", () => Effect.succeed({}))
    );
  });

/** What a grant needs of an application: its person, for `Self`, and its department. */
const grantResourceOfApplication = (id: ApplicationId) =>
  Effect.gen(function* applicationOfGrant() {
    return yield* (yield* ApplicationRepository).find(id).pipe(
      Effect.map((ref) => ({
        departmentId: ref.departmentId,
        personId: ref.personId,
      })),
      Effect.catchTag("NotFound", () => Effect.succeed({}))
    );
  });

const notWithdrawable = (id: ApplicationId) =>
  new Conflict({
    entity: "Application",
    key: String(id),
    message: ALREADY_WITHDRAWN,
  });

/** What a command on one period decides from: the repository, the clock and the period as stored now. */
const periodNow = Effect.fnUntraced(function* periodNow(id: AdmissionPeriodId) {
  yield* InTransaction;
  const periods = yield* AdmissionPeriodRepository;
  const now = yield* DateTime.now;

  return { now, period: yield* periods.findById(id), periods };
});

export const AdmissionHandlers = AdmissionRpc.toLayer({
  createAdmissionPeriod: AdmissionDomain.handle(createAdmissionPeriod, {
    resource: ({ departmentId }) => Effect.succeed({ departmentId }),
    run: ({ departmentId, end, semester, start }, principal) =>
      Effect.gen(function* schedule() {
        yield* InTransaction;

        const stored = yield* (yield* SemesterRepository).find(semester);

        if (Option.isNone(stored)) {
          return yield* validationFailed(["semester"], NO_SEMESTER);
        }

        const created = yield* (yield* AdmissionPeriodRepository).create({
          departmentId,
          end,
          semesterId: stored.value.id,
          start,
        });

        yield* recordAudit(
          principal,
          "admissionPeriod.created",
          "AdmissionPeriod",
          created.id
        );

        return created;
      }),
  }),
  deleteAdmissionPeriod: AdmissionDomain.handle(deleteAdmissionPeriod, {
    resource: ({ id }) => grantResourceOfPeriod(id),
    run: ({ id }, principal) =>
      Effect.gen(function* cancel() {
        const { now, period, periods } = yield* periodNow(id);

        if (admissionState(period, now) !== "Scheduled") {
          return yield* new Conflict({
            entity: "AdmissionPeriod",
            key: String(id),
            message: MAY_NOT_BE_CANCELLED,
          });
        }

        yield* periods.remove(id, now);

        return yield* recordAudit(
          principal,
          "admissionPeriod.deleted",
          "AdmissionPeriod",
          id
        );
      }),
  }),
  extendAdmissionPeriod: AdmissionDomain.handle(extendAdmissionPeriod, {
    resource: ({ id }) => grantResourceOfPeriod(id),
    run: ({ end, id }, principal) =>
      Effect.gen(function* extend() {
        const { now, period, periods } = yield* periodNow(id);

        if (admissionState(period, now) === "Closed") {
          return yield* new Conflict({
            entity: "AdmissionPeriod",
            key: String(id),
            message: HAS_ENDED,
          });
        }

        if (!DateTime.isGreaterThan(end, period.end)) {
          return yield* validationFailed(["end"], END_LATER);
        }

        const extended = yield* periods.extend(id, end, now);

        yield* recordAudit(
          principal,
          "admissionPeriod.extended",
          "AdmissionPeriod",
          id
        );

        return extended;
      }),
  }),
  registerApplication: AdmissionDomain.handle(registerApplication, {
    resource: ({ periodId }) => grantResourceOfPeriod(periodId),
    run: ({ periodId, ...input }, principal) =>
      Effect.gen(function* register() {
        yield* InTransaction;

        const period = yield* (yield* AdmissionPeriodRepository)
          .findById(periodId)
          .pipe(
            Effect.catchTag("NotFound", () =>
              Effect.fail(validationFailed(["periodId"], NO_PERIOD))
            )
          );

        // The period need not be open: staff register at a stand in the semester that it is for (UNMATCHED-153).
        if (SemesterOrder(period.semester, yield* currentSemester) !== 0) {
          return yield* validationFailed(["periodId"], NOT_THIS_SEMESTER);
        }

        if (
          yield* (yield* ApplicationRepository).existsForAddress(
            period.id,
            input.email
          )
        ) {
          return yield* new Conflict({
            entity: "Application",
            key: input.email,
            message: ALREADY_APPLIED,
          });
        }

        const receipt = yield* apply(period, input);

        yield* recordAudit(
          principal,
          "application.registered",
          "Application",
          receipt.applicationId
        );

        return receipt;
      }),
  }),
  submitApplication: AdmissionDomain.handle(submitApplication, {
    resource: () => Effect.succeed({}),
    run: ({ departmentId, ...input }) =>
      Effect.gen(function* submit() {
        yield* InTransaction;
        const now = yield* DateTime.now;

        const periods = Arr.filter(
          yield* (yield* AdmissionPeriodRepository).listStored,
          (period) => period.departmentId === departmentId
        );

        // The one window rule: the department's period that is open now, or no one applies (RULE-119).
        const open = openAdmissionPeriod(periods, now);

        if (Option.isNone(open)) {
          return yield* validationFailed(["departmentId"], NOT_OPEN);
        }

        return yield* apply(open.value, input);
      }),
  }),
  withdrawApplication: AdmissionDomain.handle(withdrawApplication, {
    resource: ({ id }) => grantResourceOfApplication(id),
    run: ({ id }, principal) =>
      Effect.gen(function* withdraw() {
        yield* InTransaction;
        const applications = yield* ApplicationRepository;
        const ref = yield* applications.find(id);

        const locked = yield* (yield* AggregateLocks)
          .lock("Person", ref.personId)
          .pipe(
            Effect.catchTag("NotFound", () => Effect.fail(notWithdrawable(id)))
          );

        const application = yield* applications.findLocked(locked, id);

        const [transition] = Machine.available(
          ApplicationMachine,
          "withdrawApplication",
          application.state._tag,
          {}
        );

        if (transition === undefined) {
          return yield* notWithdrawable(id);
        }

        yield* applications.transition(locked, id, transition);

        return yield* recordAudit(
          principal,
          "application.withdrawn",
          "Application",
          id
        );
      }),
  }),
});

/** The admission commands behind the in-process client; see `Commands.inProcess`. */
export const withAdmission = Commands.inProcess(
  AdmissionRpc,
  AdmissionHandlers
);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const AdmissionEndpoints = {
  createAdmissionPeriod: Commands.endpoint(createAdmissionPeriod, (payload) =>
    withAdmission((client) => client.createAdmissionPeriod(payload))
  ),
  deleteAdmissionPeriod: Commands.endpoint(deleteAdmissionPeriod, (payload) =>
    withAdmission((client) => client.deleteAdmissionPeriod(payload))
  ),
  extendAdmissionPeriod: Commands.endpoint(extendAdmissionPeriod, (payload) =>
    withAdmission((client) => client.extendAdmissionPeriod(payload))
  ),
  registerApplication: Commands.endpoint(registerApplication, (payload) =>
    withAdmission((client) => client.registerApplication(payload))
  ),
  submitApplication: Commands.endpoint(submitApplication, (payload) =>
    withAdmission((client) => client.submitApplication(payload))
  ),
  withdrawApplication: Commands.endpoint(withdrawApplication, (payload) =>
    withAdmission((client) => client.withdrawApplication(payload))
  ),
};
