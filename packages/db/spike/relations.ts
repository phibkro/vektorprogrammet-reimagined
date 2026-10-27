/**
 * Spike: Drizzle relational queries v2 (RQB v2) over the teams domain. Throwaway; see
 * `docs/research/relational-queries-spike.md`.
 */
import { defineRelations } from "drizzle-orm";

import * as schema from "../src/schema.ts";

export const relations = defineRelations(
  {
    adminGrant: schema.adminGrant,
    department: schema.department,
    fieldOfStudy: schema.fieldOfStudy,
    membership: schema.membership,
    person: schema.person,
    position: schema.position,
    team: schema.team,
  },
  (r) => ({
    adminGrant: {
      // Two foreign keys point at `person`, so each relation needs an alias that no foreign key can supply.
      grantee: r.one.person({
        alias: "grantee",
        from: r.adminGrant.personId,
        optional: false,
        to: r.person.id,
      }),
      granter: r.one.person({
        alias: "granter",
        from: r.adminGrant.grantedBy,
        to: r.person.id,
      }),
    },
    fieldOfStudy: {
      department: r.one.department({
        from: r.fieldOfStudy.departmentId,
        to: r.department.id,
      }),
    },
    membership: {
      person: r.one.person({
        from: r.membership.personId,
        optional: false,
        to: r.person.id,
      }),
      position: r.one.position({
        from: r.membership.positionId,
        optional: false,
        to: r.position.id,
      }),
      team: r.one.team({
        from: r.membership.teamId,
        optional: false,
        to: r.team.id,
      }),
    },
    person: {
      fieldOfStudy: r.one.fieldOfStudy({
        from: r.person.fieldOfStudyId,
        optional: false,
        to: r.fieldOfStudy.id,
      }),
      memberships: r.many.membership({
        from: r.person.id,
        to: r.membership.personId,
      }),
      adminGrants: r.many.adminGrant({
        alias: "grantee",
        from: r.person.id,
        to: r.adminGrant.personId,
      }),
    },
    position: {
      memberships: r.many.membership({
        from: r.position.id,
        to: r.membership.positionId,
      }),
    },
    team: {
      department: r.one.department({
        from: r.team.departmentId,
        optional: false,
        to: r.department.id,
      }),
      memberships: r.many.membership({
        from: r.team.id,
        to: r.membership.teamId,
      }),
    },
  })
);
