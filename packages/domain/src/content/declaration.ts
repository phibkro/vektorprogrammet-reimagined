/**
 * The content domain as data (spec 0006): social events (C8). The articles, texts and sponsors of the public site are
 * the CMS's (spec 0005). Phase 1's `ManageSocialEvents` capability is this command and its row: a member of a team
 * of the department.
 */
import { Rpc, RpcGroup } from "effect/rpc";

import * as Commands from "../kernel/commands.ts";
import * as Domain from "../kernel/domain.ts";
import * as Grant from "../kernel/grant.ts";
import * as Subject from "../kernel/subject.ts";
import { DomainErrorSchema } from "../shared/errors.ts";
import { SocialEvent, SocialEventInput } from "./socialEvent.ts";

export const createSocialEvent = Rpc.make("createSocialEvent", {
  error: DomainErrorSchema,
  payload: SocialEventInput,
  success: SocialEvent,
}).annotate(
  Commands.Info,
  Commands.info({
    replaces: ["RULE-188"],
    summary: "Add a social event for a department and a semester.",
  })
);

export const ContentRpc = RpcGroup.make(createSocialEvent);

export const ContentDomain = Domain.make({
  commands: ContentRpc,
  grants: [Grant.make([Subject.member], ["createSocialEvent"], "department")],
  name: "content",
  reads: {},
  title: "Content",
});
