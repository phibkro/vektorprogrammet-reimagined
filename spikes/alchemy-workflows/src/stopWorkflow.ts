/**
 * The stop sender: a second Workflow of the same Worker whose body hands a `renewal-stop` event to a renewal instance
 * through the Workflows binding. It exists for the deployed run, and only for it.
 *
 * Why: `cf` cannot send a Workflows event. Its generated schema declares no request body for the send endpoint, so it
 * rejects `--body`, and the API answers a body-less send with `400 [10002] workflows.api.error.body`. The Worker has no
 * public URL, so the HTTP stop route is out of reach. The product's own stop link would send the event from a Worker
 * through this binding: the stopper is that path, started through the Workflows API (`cf workflows instances create
 * --body`). It is a test-only, production-shaped path: no route of the Worker starts it, and nothing of the app depends
 * on it.
 *
 * The parameters are identifiers only (`StopRequestSchema`). The event's payload is `{ stoppedBy }` when the request
 * names who stopped the renewal, and empty (an anonymous stop) when it does not. The send is a task, so a replay of this
 * body does not send twice; the engine retries it natively.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

import { STOPPER_WORKFLOW_NAME } from "./names.ts";
import {
  STOP_EVENT_TYPE,
  StopSent,
  decodeStopRequest,
  encodeStopSent,
} from "./renewal.ts";
import type { StopRequestEncoded } from "./renewal.ts";
import RenewalWorkflow from "./renewalWorkflow.ts";

const RETRIES = {
  retries: { backoff: "constant", delay: "1 second", limit: 3 },
} as const;

export default class StopperWorkflow extends Cloudflare.Workflow<StopperWorkflow>()(
  "MembershipRenewalStopper",
  { workflowName: STOPPER_WORKFLOW_NAME },
  Effect.gen(function* stopperWorkflow() {
    const renewals = yield* RenewalWorkflow;

    return Effect.fn("MembershipRenewalStopper.run")(function* run(
      raw: StopRequestEncoded
    ) {
      const request = yield* decodeStopRequest(raw).pipe(Effect.orDie);

      const payload =
        request.stoppedBy === undefined ? {} : { stoppedBy: request.stoppedBy };

      const sent = yield* Cloudflare.Workflows.task(
        "send-stop",
        renewals.get(request.renewalId).pipe(
          Effect.flatMap((instance) =>
            instance.sendEvent({ payload, type: STOP_EVENT_TYPE })
          ),
          Effect.as(StopSent.make({ renewalId: request.renewalId }))
        ),
        RETRIES
      );

      return yield* encodeStopSent(sent);
    });
  })
) {}
