/** What a first membership leaves for a person (RULE-248): the welcome claim, the welcome mails queued for them, and their memberships. */
import type { Person } from "@vektorprogrammet/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export const countsFor = (person: Person) =>
  Effect.gen(function* welcomeCounts() {
    const sql = yield* SqlClient;

    const [ledger] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from welcome_ledger where person_id = ${person.id}`;

    const [mail] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from outbox where kind = 'Email' and payload ->> 'to' = ${person.email}`;

    const [memberships] = yield* sql<{
      readonly n: number;
    }>`select count(*)::int as n from membership where person_id = ${person.id}`;

    return [ledger?.n, mail?.n, memberships?.n];
  });
