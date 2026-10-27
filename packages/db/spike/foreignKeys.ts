/** What the schema's own foreign keys say: the raw material for generated relations. */
import { getTableConfig } from "drizzle-orm/pg-core";
import { Array as Arr, Console, Effect } from "effect";

import * as schema from "../src/schema.ts";

const rows = Arr.flatMap(Object.values(schema), (table) => {
  if (typeof table !== "object" || table === null || !("getSQL" in table || Symbol.for("drizzle:Name") in table)) {
    return [];
  }
  try {
    const config = getTableConfig(table as never);

    return Arr.map(config.foreignKeys, (fk) => {
      const ref = fk.reference();

      return `${config.name}.${Arr.map(ref.columns, (c) => `${c.name}${c.notNull ? " NOT NULL" : ""}`).join(",")} -> ${getTableConfig(ref.foreignTable).name}.${Arr.map(ref.foreignColumns, (c) => c.name).join(",")}`;
    });
  } catch {
    return [];
  }
});

await Effect.runPromise(Console.log(rows.join("\n")));
