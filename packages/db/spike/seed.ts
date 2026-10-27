/**
 * Production-volume fake data, deterministic: 5 departments, 20 fields of study, 3000 persons, 23 teams and
 * 780 memberships. Terms run from Vår 2018 to Høst 2026 (ordinals 4036 to 4053); the current semester is Høst 2026
 * (4053). No person holds two memberships in one team, so the exclusion constraint is satisfied by construction.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

const statements = [
  `insert into department (name, short_name, city, email)
     select 'Avdeling ' || d, 'A' || d, 'By ' || d, 'a' || d || '@example.org' from generate_series(1, 5) d`,
  `insert into field_of_study (department_id, name, short_name)
     select ((f - 1) % 5) + 1, 'Linje ' || f, 'L' || f from generate_series(1, 20) f`,
  `insert into person (email, name, field_of_study_id)
     select 'p' || i || '@example.org', 'Person ' || lpad(((i * 7919) % 3001)::text, 5, '0') || ' ' || i, ((i - 1) % 20) + 1
     from generate_series(1, 3000) i`,
  `insert into team (name, department_id, function, default_term, active)
     select 'Team ' || lpad(t::text, 2, '0'), ((t - 1) % 5) + 1,
       (array['board','economy','it','recruitment','placement','other'])[(t % 6) + 1]::team_function, ((t % 2) + 1), true
     from generate_series(1, 23) t`,
  // 780 memberships: person (i * 3 mod 3000) + 1 is unique per i <= 1000, team cycles, so no overlap is possible.
  `with m as (
     select i,
            4053 - floor(17.99 * power(((i * 7919) % 1000) / 1000.0, 2))::int as s,
            1 + ((i * 17) % 4) as len
     from generate_series(1, 780) i
   )
   insert into membership (person_id, team_id, position_id, leader, start_term, start_year, end_term, end_year)
   select ((i * 3) % 3000) + 1,
          ((i - 1) % 23) + 1,
          (select id from position where name = case when i % 9 = 0 then 'Leder' else 'Medlem' end),
          i % 9 = 0,
          (case when s % 2 = 1 then 'HOST' else 'VAR' end)::semester_term, s / 2,
          (case when least(s + len - 1, 4053) % 2 = 1 then 'HOST' else 'VAR' end)::semester_term, least(s + len - 1, 4053) / 2
   from m`,
  "analyze",
];

export const seedProductionVolume = Effect.gen(function* seedProductionVolume() {
  const sql = yield* SqlClient;
  yield* Effect.forEach(statements, (statement) => sql.unsafe(statement), {
    discard: true,
  });
  const [counts] = yield* sql.unsafe<{
    memberships: number;
    people: number;
    teams: number;
  }>(
    `select (select count(*)::int from person) as people, (select count(*)::int from team) as teams,
            (select count(*)::int from membership) as memberships`
  );

  return counts;
});
