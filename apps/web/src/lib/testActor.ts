/** The local-only test actor selection (client-safe; the actors themselves live in `server/actor.ts`). */
export const TEST_ACTOR_COOKIE = "vp-test-actor";
export const TEST_ACTOR_NAMES = ["admin", "teamLeader"] as const;
export type TestActorName = (typeof TEST_ACTOR_NAMES)[number];
