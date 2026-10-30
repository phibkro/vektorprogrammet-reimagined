import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Effect, Predicate } from "effect";
import type { Schema } from "effect";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { toFormData } from "@/forms/formSchema";
import type { FormText } from "@/forms/formSchema";
import { fieldErrors } from "@/lib/outcome";
import type { Outcome } from "@/lib/outcome";

import { FormAlert, RegisterFieldContext, ServerIssuesContext } from "./field";
import type { FieldComponent, RegisterField } from "./field";
import { useConstructForm } from "./useConstructForm";

/** How many `Field`s of each name are on screen: `name` is a place for a message while its count is above 0. */
const countField = (
  counts: ReadonlyMap<string, number>,
  name: string,
  change: 1 | -1
): ReadonlyMap<string, number> => {
  const count = (counts.get(name) ?? 0) + change;
  const next = new Map(counts);

  if (count > 0) {
    next.set(name, count);
  } else {
    next.delete(name);
  }

  return next;
};

/**
 * A form backed by a server function that takes `FormData` and answers an `Outcome` notice (spec 0010a). The form's
 * `schema` is what the browser validates the values with before anything is sent, and what the server decodes the post
 * with; `defaults` are the values it starts from (a hidden `id` is a value, not an input). On success the route's data
 * is re-loaded and `onSuccess` runs (a Sheet closes). A failure stays on screen: a validation issue under its field,
 * every other refusal (a 403, a duplicate) and an issue on a field that is not rendered (a hidden `id`, issue 26) in
 * the form's one alert. The browser's own validation is off, so the only rules and messages are the domain's.
 */
export interface CommandFormViewProps<
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
> {
  /** The inputs of the form, as a function of its bound `Field`; a form without inputs has none. */
  children?: (Field: FieldComponent<S["Encoded"]>) => ReactNode;
  className?: string;
  defaults: S["Encoded"];
  extraActions?: ReactNode;
  onSuccess?: () => void;
  /** Re-loads the route's data after a command succeeded. */
  reload: () => Promise<void>;
  /** Posts the form's `FormData` to the server function. */
  run: (options: { data: FormData }) => Promise<Outcome<string>>;
  schema: S;
  submitLabel: string;
}

export const CommandFormView = <
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
>({
  children,
  className,
  defaults,
  extraActions,
  onSuccess,
  reload,
  run,
  schema,
  submitLabel,
}: CommandFormViewProps<S>) => {
  const [outcome, setOutcome] = useState<Outcome<string> | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());

  const { Field, form, onSubmit } = useConstructForm({
    defaults,
    onRefused: () => {
      setOutcome(null);
      setCrashed(false);
    },
    onValid: (values, reset) => {
      setCrashed(false);

      return Effect.gen(function* submitCommand() {
        const result = yield* Effect.tryPromise(() =>
          run({ data: toFormData(values) })
        );

        yield* Effect.sync(() => {
          setOutcome(result);
        });

        if (Predicate.isTagged(result, "Success")) {
          yield* Effect.sync(reset);
          yield* Effect.tryPromise(reload);
          yield* Effect.sync(() => {
            onSuccess?.();
          });
        }
      }).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            setOutcome(null);
            setCrashed(true);
          })
        ),
        Effect.runPromise
      );
    },
    schema,
  });

  const register = useCallback<RegisterField>((name) => {
    setCounts((current) => countField(current, name, 1));

    return () => {
      setCounts((current) => countField(current, name, -1));
    };
  }, []);

  const shown = useMemo(() => new Set(counts.keys()), [counts]);

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className={className ?? "grid max-w-xl gap-4"}
    >
      <RegisterFieldContext.Provider value={register}>
        <ServerIssuesContext.Provider value={fieldErrors(outcome)}>
          {children?.(Field)}
        </ServerIssuesContext.Provider>
      </RegisterFieldContext.Provider>
      <FormAlert crashed={crashed} outcome={outcome} shown={shown} />
      <div className="flex items-center gap-3">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(pending) => (
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          )}
        </form.Subscribe>
        {extraActions}
        {Predicate.isTagged(outcome, "Success") && (
          <p role="status" className="text-success text-sm">
            {outcome.value}
          </p>
        )}
      </div>
    </form>
  );
};

/** The form for a server function: `CommandFormView` with the function wrapped for the browser, and the route's reload. */
export const CommandForm = <
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
>({
  action,
  ...props
}: Omit<CommandFormViewProps<S>, "reload" | "run"> & {
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
}) => {
  const router = useRouter();
  const run = useServerFn(action);

  return (
    <CommandFormView {...props} reload={() => router.invalidate()} run={run} />
  );
};
