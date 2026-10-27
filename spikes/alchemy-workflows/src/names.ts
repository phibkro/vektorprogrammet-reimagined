/**
 * The names of the spike's Cloudflare resources. Every one carries the prefix, so that a list call can prove that the
 * teardown removed exactly these and nothing else in the account. A Workflow's name is account-global.
 */
const PREFIX = "vp-spike-workflows";

export const WORKER_NAME = PREFIX;

export const HYPERDRIVE_NAME = `${PREFIX}-neon`;

export const WORKFLOW_NAME = `${PREFIX}-renewal`;

/** The test-only stop sender (`stopWorkflow.ts`): a second Workflow of the same Worker. */
export const STOPPER_WORKFLOW_NAME = `${PREFIX}-stopper`;
