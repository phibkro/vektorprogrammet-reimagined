/**
 * What makes the job registry incomplete (spec 0008). Empty means complete. The test of the real registry asserts it,
 * the doc generator refuses to render otherwise, and each check has a negative control that changes one line.
 *
 * The kernel already checks each declaration's own jobs (`Domain.problems`: a job's command is granted to its own
 * `System` principal alone, and a job's command that no grant names is reported). What only the whole list shows is
 * checked here: a `System` principal without a declaration, a declaration without a command, a name declared twice.
 */
import { Array as Arr, Option } from "effect";

import { infoOf } from "../kernel/commands.ts";
import type { Declaration } from "../kernel/domain.ts";
import { SystemJob } from "../kernel/principal.ts";
import type { Job } from "./job.ts";

const commandsOf = (
  name: SystemJob,
  domains: readonly Declaration[]
): readonly string[] =>
  Arr.flatMap(domains, (domain) =>
    Arr.flatMap(domain.commands, (rpc) =>
      Option.exists(infoOf(rpc), (info) => info.job === name) ? [rpc._tag] : []
    )
  );

export const jobProblems = (
  jobs: readonly Job[],
  domains: readonly Declaration[]
): readonly string[] => {
  const names = Arr.map(jobs, (job) => job.name);

  return [
    ...Arr.map(
      Arr.filter(names, (name, index) => names.indexOf(name) !== index),
      (name) => `${name} is declared twice`
    ),
    ...Arr.flatMap(SystemJob.literals, (name) =>
      Arr.contains(names, name)
        ? []
        : [`${name} is a System principal and the registry has no declaration`]
    ),
    ...Arr.flatMap(jobs, (job) =>
      Arr.isReadonlyArrayEmpty(commandsOf(job.name, domains))
        ? [`${job.name} is declared and no command is its job's command`]
        : []
    ),
  ];
};
