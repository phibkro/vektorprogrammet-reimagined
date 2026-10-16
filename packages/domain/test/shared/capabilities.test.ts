import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  Capability,
  CurrentActor,
  anonymous,
  authorize,
  requireCapability,
} from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  admin,
  asActor,
  boardMember,
  failureTag,
  teamLeaderTrondheim,
  teamMemberBergen,
} from "../support/inMemory.ts";

const every: readonly Capability[] = [
  Capability.EditStaticContent(),
  Capability.ManageSemesters(),
  Capability.CreateDepartment(),
  Capability.UpdateDepartment({ departmentId: TRONDHEIM }),
  Capability.ManageFieldsOfStudy({ departmentId: TRONDHEIM }),
  Capability.ManageArticles(),
  Capability.ManageSponsors(),
  Capability.ManageSocialEvents({ departmentId: TRONDHEIM }),
  Capability.UploadFiles(),
  Capability.ReadAudit(),
];

describe("capabilities: deny by default, scoped by department", () => {
  it("an anonymous actor holds no capability", () => {
    for (const capability of every) {
      assert.isFalse(authorize(anonymous, capability), capability._tag);
    }
  });

  it("an admin holds every capability in every department", () => {
    for (const capability of every) {
      assert.isTrue(authorize(admin, capability), capability._tag);
    }

    assert.isTrue(
      authorize(admin, Capability.ManageFieldsOfStudy({ departmentId: BERGEN }))
    );
  });

  it("RULE-296: static content is editable only by an admin or an executive-board member", () => {
    const edit = Capability.EditStaticContent();
    assert.isTrue(authorize(admin, edit));
    assert.isTrue(authorize(boardMember, edit));
    assert.isFalse(authorize(teamLeaderTrondheim, edit));
    assert.isFalse(authorize(teamMemberBergen, edit));
    assert.isFalse(authorize(anonymous, edit));
  });

  it("RULE-139: fields of study are managed only within one's own department", () => {
    assert.isTrue(
      authorize(
        teamLeaderTrondheim,
        Capability.ManageFieldsOfStudy({ departmentId: TRONDHEIM })
      )
    );
    assert.isFalse(
      authorize(
        teamLeaderTrondheim,
        Capability.ManageFieldsOfStudy({ departmentId: BERGEN })
      )
    );
    assert.isFalse(
      authorize(
        teamMemberBergen,
        Capability.ManageFieldsOfStudy({ departmentId: BERGEN })
      )
    );
  });

  it("social events are scoped to the staff member's department", () => {
    assert.isTrue(
      authorize(
        teamMemberBergen,
        Capability.ManageSocialEvents({ departmentId: BERGEN })
      )
    );
    assert.isFalse(
      authorize(
        teamMemberBergen,
        Capability.ManageSocialEvents({ departmentId: TRONDHEIM })
      )
    );
  });

  it.effect(
    "requireCapability fails with Forbidden naming the capability",
    () =>
      Effect.gen(function* effectProgram() {
        const exit = yield* Effect.exit(
          asActor(teamMemberBergen)(requireCapability(Capability.ReadAudit()))
        );

        assert.strictEqual(failureTag(exit), "Forbidden");

        const error = yield* Effect.flip(
          requireCapability(Capability.ReadAudit()).pipe(
            Effect.provideService(CurrentActor, anonymous)
          )
        );

        assert.strictEqual(error.capability, "ReadAudit");
      })
  );
});
