/** The outbox message that `workspace` enqueues (ADR 0015 stage 3, spec 0022 R4). The catalog lists it (`outbox/messages.ts`). */
import { declareMessage } from "../shared/outbox.ts";
import { WorkspaceChange } from "./change.ts";

/** A change to the Google Workspace directory (spec 0008): delivered by the sweep to `WorkspaceWriter`, not a transport message. */
export const WorkspaceChangeMessage = declareMessage("WorkspaceChange", {
  change: WorkspaceChange,
});
