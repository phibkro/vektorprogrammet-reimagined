import * as Domain from "@alchemy.run/domain";
import { Layer } from "effect";

import { AdminList } from "./adminList.ts";
import { Person } from "./person.ts";
import {
  AdminRows,
  AdminRowsLive,
  MembershipRows,
  MembershipRowsLive,
} from "./projections.ts";

/** The SQL projections are hosted by the custom PostgreSQL platform. */
export class StaffingModel extends Domain.Model("StaffingModel", {
  aggregates: [Person, AdminList],
  projections: [MembershipRows, AdminRows],
}) {}

export const staffingProjections = Layer.mergeAll(
  MembershipRowsLive,
  AdminRowsLive
);

/** The same aggregate decisions without SQL projections, for a Story. */
export class StaffingStoryModel extends Domain.Model("StaffingStoryModel", {
  aggregates: [Person, AdminList],
}) {}
