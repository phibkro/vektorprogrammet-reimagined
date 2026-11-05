import { Config, Effect, Schema } from "effect";

// EX-0032: Schema.TaggedError is a class factory, not a constructor.
export class PreviewError extends Schema.TaggedError<
  PreviewError,
  { readonly brand: unique symbol }
>()("PreviewError", {
  message: Schema.String,
}) {}

const EXPECTED_REPOSITORY = "phibkro/vektorprogrammet-reimagined";

export interface PreviewIdentity {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly parentProjectRef: string;
  readonly branchName: string;
  readonly workerName: string;
  readonly siteUrl: string;
}

export const readIdentity = Effect.fnUntraced(function* readIdentity() {
  const repository = yield* Config.String("GITHUB_REPOSITORY");
  const pr = yield* Config.String("PREVIEW_PR_NUMBER");
  const headSha = yield* Config.String("PREVIEW_HEAD_SHA");
  const parentProjectRef = yield* Config.String("SUPABASE_PREVIEW_PROJECT_REF");
  const subdomain = yield* Config.String("CLOUDFLARE_WORKERS_SUBDOMAIN");

  if (
    repository !== EXPECTED_REPOSITORY ||
    !pr ||
    !/^[1-9][0-9]*$/u.test(pr) ||
    !Number.isSafeInteger(Number(pr)) ||
    !headSha ||
    !/^[a-f0-9]{40}$/u.test(headSha) ||
    !parentProjectRef ||
    !/^[a-z0-9]{20}$/u.test(parentProjectRef) ||
    !subdomain ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)
  ) {
    return yield* new PreviewError({
      message: "Invalid or missing preview identity configuration",
    });
  }

  const name = `vektorprogrammet-pr-${pr}`;

  if (name.length > 63) {
    return yield* new PreviewError({ message: "Preview name is too long" });
  }

  return {
    branchName: name,
    headSha,
    parentProjectRef,
    pullRequest: Number(pr),
    repository,
    siteUrl: `https://${name}.${subdomain}.workers.dev`,
    workerName: name,
  } satisfies PreviewIdentity;
});
