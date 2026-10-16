/**
 * Content commands (staff writes: require `InTransaction`, authorize, validate, write, audit). The news,
 * static texts and sponsors of the public site are the CMS's (spec 0005); social events (C8) stay here.
 */
import { Effect } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import {
  Capability,
  requireCapability,
  requireStaff,
} from "../shared/capabilities.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput } from "../shared/validation.ts";
import { SocialEventRepository } from "./services.ts";
import { SocialEventInput } from "./socialEvent.ts";

const decodeSocialEventInput = decodeInput(SocialEventInput);

/** RULE-188: saved for the chosen department and semester; no role field. */
export const createSocialEvent = Effect.fn("createSocialEvent")(
  function* createSocialEvent(input: unknown) {
    yield* InTransaction;
    yield* requireStaff;
    const event = yield* decodeSocialEventInput(input);

    const actor = yield* requireCapability(
      Capability.ManageSocialEvents({ departmentId: event.departmentId })
    );

    const events = yield* SocialEventRepository;
    const created = yield* events.create(event);
    yield* recordAudit(actor, "socialEvent.created", "SocialEvent", created.id);

    return created;
  }
);
