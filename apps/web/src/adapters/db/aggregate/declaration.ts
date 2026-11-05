/**
 * The aggregate roots of the schema and the tables they own (spec 0006b): `Ownership` (the data) over `schema.ts` (the
 * tables). A repository takes the handle of a table it writes from here: `Person.owned.membership`.
 */
import * as schema from "../schema.ts";
import { declare } from "./model.ts";
import { Ownership } from "./ownership.ts";

export const roots = declare(Ownership, schema);

export const { Person } = roots;
