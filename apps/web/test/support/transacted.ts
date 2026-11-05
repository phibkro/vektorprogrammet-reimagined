import type { Effect } from "effect";

import type { NotAnIntegration } from "../../src/domain/transactions/transaction";
import { Transactor } from "../../src/domain/transactions/transactor";

/** `program` as one transaction, through the domain's `Transactor` (the layer of `DatabaseLive` provides it). */
export const transacted = <A, E, R extends NotAnIntegration>(
  program: Effect.Effect<A, E, R>
) => Transactor.use((transactor) => transactor.run(program));
