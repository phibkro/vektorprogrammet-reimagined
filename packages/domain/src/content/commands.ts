/**
 * Content command handlers (staff writes: require `InTransaction`, are authorized by the grant table, write and
 * audit). The news, static texts and sponsors of the public site are the CMS's (spec 0005); social events (C8) stay
 * here.
 */
import { Effect } from "effect";

import { recordAudit } from "../audit/auditLog.ts";
import * as Commands from "../kernel/commands.ts";
import { InTransaction } from "../shared/transaction.ts";
import { ContentDomain, ContentRpc, createSocialEvent } from "./declaration.ts";
import { SocialEventRepository } from "./services.ts";

export const ContentHandlers = ContentRpc.toLayer({
  /** RULE-188: saved for the chosen department and semester; no role field. */
  createSocialEvent: ContentDomain.handle(createSocialEvent, {
    resource: ({ departmentId }) => Effect.succeed({ departmentId }),
    run: (event, principal) =>
      Effect.gen(function* run() {
        yield* InTransaction;
        const events = yield* SocialEventRepository;
        const created = yield* events.create(event);
        yield* recordAudit(
          principal,
          "socialEvent.created",
          "SocialEvent",
          created.id
        );

        return created;
      }),
  }),
});

/** The content commands behind the in-process client; see `Commands.inProcess`. */
export const withContent = Commands.inProcess(ContentRpc, ContentHandlers);

/** The server functions' entries: untrusted input in, the command's own result out (`Commands.endpoint`). */
export const ContentEndpoints = {
  createSocialEvent: Commands.endpoint(createSocialEvent, (payload) =>
    withContent((client) => client.createSocialEvent(payload))
  ),
};
