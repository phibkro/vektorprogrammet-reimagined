import { Transactor } from "@vektorprogrammet/domain";
import type { Effect } from "effect";

/** `program` as one transaction, through the domain's `Transactor` (the layer of `DatabaseLive` provides it). */
export const transacted = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Transactor.use((transactor) => transactor.run(program));
