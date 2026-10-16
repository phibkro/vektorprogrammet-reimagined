/** Content repositories (C8). `packages/db` implements them as Layers. */
import { Context } from "effect";
import type { Effect } from "effect";

import type { DepartmentId, SemesterId } from "../shared/ids.ts";
import type { SocialEvent, SocialEventDraft } from "./socialEvent.ts";

export class SocialEventRepository extends Context.Service<
  SocialEventRepository,
  {
    readonly list: (filter: {
      readonly departmentId: DepartmentId;
      readonly semesterId: SemesterId;
    }) => Effect.Effect<readonly SocialEvent[]>;
    readonly create: (draft: SocialEventDraft) => Effect.Effect<SocialEvent>;
  }
>()("@vektorprogrammet/domain/content/SocialEventRepository") {}
