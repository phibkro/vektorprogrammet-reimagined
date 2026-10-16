import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Array as Arr, Effect, Predicate } from "effect";
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { fieldErrors, formLevelMessage } from "@/lib/outcome";
import type { Outcome } from "@/lib/outcome";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

const FieldErrorsContext = createContext<FieldErrors>({});

/** Provides field messages (e.g. from a no-JavaScript re-render) to the `Field`s below it. */
export const FieldErrorsProvider = ({
  errors,
  children,
}: {
  errors: FieldErrors;
  children: ReactNode;
}) => (
  <FieldErrorsContext.Provider value={errors}>
    {children}
  </FieldErrorsContext.Provider>
);

/**
 * A labelled control plus the messages for `name` (dotted path of a
 * `ValidationFailed` issue). The label wraps the control, so several forms on
 * one page need no unique ids.
 */
export const Field = ({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: ReactNode;
}) => {
  const messages = useContext(FieldErrorsContext)[name] ?? [];

  return (
    <div className="grid gap-1.5">
      <Label className="grid">
        <span className="mb-1.5">{label}</span>
        {children}
      </Label>
      {Arr.map(messages, (message) => (
        <p key={message} className="text-destructive text-sm">
          {message}
        </p>
      ))}
    </div>
  );
};

/**
 * A control-panel form backed by a server function that takes `FormData` and
 * answers an `Outcome` notice. On success the route's data is re-loaded and
 * `onSuccess` runs (a dialog closes). A failure stays on screen: validation
 * messages under their field, every other refusal (403, a duplicate) in an alert.
 * The browser's own validation is off (`noValidate`), so the only rules and the only
 * messages are the domain's.
 */
export const CommandForm = ({
  action,
  submitLabel,
  children,
  className,
  onSuccess,
  extraActions,
}: {
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
  onSuccess?: () => void;
  extraActions?: ReactNode;
}) => {
  const router = useRouter();
  const run = useServerFn(action);
  const [outcome, setOutcome] = useState<Outcome<string> | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [pending, setPending] = useState(false);

  const onSubmit = (event: {
    currentTarget: HTMLFormElement;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setCrashed(false);
    const data = new FormData(form);

    Effect.gen(function* submitCommand() {
      const result = yield* Effect.tryPromise(() => run({ data }));
      yield* Effect.sync(() => {
        setOutcome(result);
      });

      if (Predicate.isTagged(result, "Success")) {
        yield* Effect.sync(() => {
          form.reset();
        });
        yield* Effect.tryPromise(() => router.invalidate());
        yield* Effect.sync(() => {
          onSuccess?.();
        });
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          setOutcome(null);
          setCrashed(true);
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          setPending(false);
        })
      ),
      Effect.runFork
    );
  };

  const problem = crashed
    ? "Noe gikk galt. Prøv igjen senere."
    : formLevelMessage(outcome);

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className={className ?? "grid max-w-xl gap-4"}
    >
      <FieldErrorsProvider errors={fieldErrors(outcome)}>
        {children}
      </FieldErrorsProvider>
      {problem !== null && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
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

export const nativeSelectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
