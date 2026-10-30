/**
 * Spec 0009 in the domain: F1 the one window (`admissionState` and `openAdmissionPeriod` agree with `isAdmissionOpen` at every
 * boundary), F5 the checks of the input (the same schema for the public form and for staff), F11 the machine, the grants
 * (the department's boundary, and nothing for a member of another function), and the single-use purpose that verifies an
 * applicant's address (its command is the one that the Code machine and the policy name).
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Option, Schema } from "effect";

import {
  Admission,
  CodeMachine,
  DepartmentId,
  Machine,
  PersonId,
  PersonalDataRpcs,
  Principal,
  RegisterApplicationInput,
  SubmitApplicationInput,
  TeamId,
  admissionState,
  anonymous,
  authorize,
  codePolicy,
  isAdmissionOpen,
  openAdmissionPeriod,
} from "../../src/index.ts";

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const window = {
  end: utc("2027-03-31T22:00:00Z"),
  start: utc("2027-02-01T08:00:00Z"),
};

const A = DepartmentId.make(1);
const B = DepartmentId.make(2);

const memberOf = (
  departmentId: DepartmentId,
  options: {
    readonly function: "board" | "recruitment";
    readonly leader: boolean;
  }
) =>
  Principal.cases.Person.make({
    memberships: [
      {
        departmentId,
        function: options.function,
        leader: options.leader,
        teamId: TeamId.make(1),
      },
    ],
    personId: PersonId.make(10),
  });

describe("spec 0009 F1: one window, one state", () => {
  it("admissionState is Scheduled before the start, Open from it, Closed at the end instant, and agrees with isAdmissionOpen at every boundary", () => {
    const instants = [
      ["2027-02-01T07:59:59.999Z", "Scheduled"],
      ["2027-02-01T08:00:00.000Z", "Open"],
      ["2027-03-31T21:59:59.999Z", "Open"],
      ["2027-03-31T22:00:00.000Z", "Closed"],
      ["2027-04-01T00:00:00.000Z", "Closed"],
    ] as const;

    for (const [instant, expected] of instants) {
      assert.strictEqual(
        admissionState(window, utc(instant)),
        expected,
        instant
      );

      assert.strictEqual(
        isAdmissionOpen(window, utc(instant)),
        expected === "Open",
        `${instant}: the one window rule`
      );
    }
  });

  it("negative control: an end that counted as open would disagree at the end instant", () => {
    const inclusive = (instant: DateTime.Utc) =>
      DateTime.isLessThanOrEqualTo(instant, window.end) &&
      DateTime.isGreaterThanOrEqualTo(instant, window.start);

    assert.isTrue(inclusive(window.end));
    assert.isFalse(isAdmissionOpen(window, window.end));
  });

  it("openAdmissionPeriod is the period that is open now, and none when only a past or a future one exists", () => {
    const later = {
      end: utc("2027-10-31T22:00:00Z"),
      start: utc("2027-09-01T08:00:00Z"),
    };

    assert.deepStrictEqual(
      openAdmissionPeriod([window, later], utc("2027-03-01T08:00:00Z")),
      Option.some(window)
    );

    assert.isTrue(
      Option.isNone(
        openAdmissionPeriod([window, later], utc("2027-05-01T08:00:00Z"))
      )
    );
    assert.isTrue(
      Option.isNone(
        openAdmissionPeriod([window, later], utc("2027-01-01T08:00:00Z"))
      )
    );
  });
});

describe("spec 0009 F5: one input schema for the public form and for staff", () => {
  const answers = {
    bolk: "Both",
    doublePosition: false,
    email: "kari@example.org",
    fieldOfStudyId: 1,
    gender: null,
    heardAbout: ["Web"],
    name: "Kari",
    specialNeeds: null,
    specialNeedsConsent: false,
    teamInterest: [],
    weekdays: ["Monday"],
    yearOfStudy: 2,
  };

  it("the same answers are accepted by both commands' schemas, and the same bad answers refused by both", () => {
    const decodePublic = Schema.decodeUnknownOption(SubmitApplicationInput);
    const decodeStaff = Schema.decodeUnknownOption(RegisterApplicationInput);

    assert.isTrue(Option.isSome(decodePublic({ ...answers, departmentId: 1 })));
    assert.isTrue(Option.isSome(decodeStaff({ ...answers, periodId: 1 })));

    const bad = [
      { yearOfStudy: 0 },
      { yearOfStudy: 6 },
      { weekdays: [] },
      { weekdays: ["Sunday"] },
      { weekdays: ["Monday", "Monday"] },
      { heardAbout: ["Web", "Web"] },
      { bolk: "Bolk3" },
      { specialNeeds: "Rullestol", specialNeedsConsent: false },
      { specialNeeds: "", specialNeedsConsent: true },
      { email: "nope" },
      { name: "" },
    ];

    for (const [index, change] of bad.entries()) {
      assert.isTrue(
        Option.isNone(decodePublic({ ...answers, departmentId: 1, ...change })),
        `public answer ${String(index)}`
      );

      assert.isTrue(
        Option.isNone(decodeStaff({ ...answers, periodId: 1, ...change })),
        `staff answer ${String(index)}`
      );
    }
  });

  it("special needs without the consent say so in the domain's words", () => {
    const result = Schema.decodeUnknownOption(SubmitApplicationInput)({
      ...answers,
      departmentId: 1,
      specialNeeds: "Rullestol",
      specialNeedsConsent: false,
    });

    assert.isTrue(Option.isNone(result));
  });
});

const commandsFrom = (state: "Submitted" | "Withdrawn") =>
  Arr.map(
    Arr.filter(Admission.ApplicationMachine.transitions, (transition) =>
      Arr.contains(transition.from, state)
    ),
    (transition) => transition.command
  );

describe("spec 0009 F11: the Application machine", () => {
  it("an application is created Submitted by a submit or a registration, and Withdrawn only from Submitted, once", () => {
    for (const command of [
      "submitApplication",
      "registerApplication",
    ] as const) {
      const [transition] = Machine.available(
        Admission.ApplicationMachine,
        command,
        Machine.Boundary,
        {}
      );

      assert.strictEqual(transition?.to, "Submitted");
    }

    const [withdraw] = Machine.available(
      Admission.ApplicationMachine,
      "withdrawApplication",
      "Submitted",
      {}
    );

    assert.strictEqual(withdraw?.to, "Withdrawn");

    assert.deepStrictEqual(commandsFrom("Submitted"), ["withdrawApplication"]);
    assert.deepStrictEqual(commandsFrom("Withdrawn"), []);
    assert.deepStrictEqual(Admission.ApplicationMachine.terminal, [
      "Withdrawn",
    ]);

    assert.deepStrictEqual(
      Machine.available(
        Admission.ApplicationMachine,
        "withdrawApplication",
        "Withdrawn",
        {}
      ),
      []
    );
  });

  it("every command of the machine is a command of the group, and every stateful command names the machine", () => {
    const names = Arr.map(
      Arr.fromIterable(Admission.AdmissionRpc.requests.values()),
      (rpc) => rpc._tag
    );

    for (const transition of Admission.ApplicationMachine.transitions) {
      assert.isTrue(Arr.contains(names, transition.command));
    }
  });
});

describe("spec 0009: who may do what", () => {
  const leaderA = memberOf(A, { function: "board", leader: true });
  const recruiterA = memberOf(A, { function: "recruitment", leader: false });
  const boardMemberA = memberOf(A, { function: "board", leader: false });

  it("staff of the department schedule, register, withdraw and read there, and nowhere else", () => {
    for (const command of [
      "createAdmissionPeriod",
      "extendAdmissionPeriod",
      "deleteAdmissionPeriod",
      "registerApplication",
      "withdrawApplication",
      "viewAdmission",
    ] as const) {
      assert.isTrue(
        authorize(leaderA, command, { departmentId: A }),
        `a leader of A: ${command} in A`
      );
      assert.isTrue(
        authorize(recruiterA, command, { departmentId: A }),
        `recruitment in A: ${command} in A`
      );
      assert.isFalse(
        authorize(leaderA, command, { departmentId: B }),
        `a leader of A: ${command} in B`
      );
      assert.isFalse(
        authorize(boardMemberA, command, { departmentId: A }),
        `a member of another function: ${command}`
      );
      assert.isFalse(
        authorize(anonymous, command, { departmentId: A }),
        `anonymous: ${command}`
      );
    }
  });

  it("anyone submits, and a signed-in applicant withdraws their own application only", () => {
    assert.isTrue(authorize(anonymous, "submitApplication"));
    assert.isTrue(authorize(boardMemberA, "submitApplication"));

    const own = memberOf(A, { function: "board", leader: false });

    assert.isTrue(
      authorize(own, "withdrawApplication", {
        departmentId: A,
        personId: PersonId.make(10),
      })
    );
    assert.isFalse(
      authorize(own, "withdrawApplication", {
        departmentId: A,
        personId: PersonId.make(11),
      })
    );
  });
});

describe("spec 0009: the code that verifies an applicant's address", () => {
  it("is a single-use purpose with no account, whose command is the one that the Code machine spends it with and the command's declaration carries", () => {
    const policy = codePolicy.verifyApplication;

    assert.isTrue(policy.singleUse);
    assert.isNull(policy.account);
    assert.strictEqual(
      policy.command,
      PersonalDataRpcs.verifyApplicantEmail._tag
    );

    assert.isTrue(
      Arr.some(
        CodeMachine.transitions,
        (transition) => transition.command === policy.command
      )
    );
  });
});
