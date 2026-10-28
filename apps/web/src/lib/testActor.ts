/**
 * The local-only test actor selection (client-safe). The actor is one of the seeded people (`@vektorprogrammet/domain`
 * `LOCAL_PEOPLE`), chosen by name in the `vp-test-actor` cookie; `ANONYMOUS_CHOICE` chooses nobody. The people
 * themselves are rows of the local database, loaded by `server/principal.ts`.
 */
export const TEST_ACTOR_COOKIE = "vp-test-actor";

export const ANONYMOUS_CHOICE = "anonymous";
