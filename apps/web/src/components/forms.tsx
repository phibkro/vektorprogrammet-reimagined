import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Array as Arr, Effect, Predicate } from "effect";
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { fieldErrors } from "@/lib/outcome";
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
 * answers an `Outcome` notice. On success the route's data is re-loaded.
 */
export const CommandForm = ({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
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

  let status: { ok: boolean; text: string } | null = null;

  if (crashed) {
    status = { ok: false, text: "Noe gikk galt. Prøv igjen senere." };
  } else if (outcome !== null) {
    status = Predicate.isTagged(outcome, "Success")
      ? { ok: true, text: outcome.value }
      : { ok: false, text: outcome.message };
  }

  return (
    <form onSubmit={onSubmit} className={className ?? "grid max-w-xl gap-4"}>
      <FieldErrorsProvider errors={fieldErrors(outcome)}>
        {children}
      </FieldErrorsProvider>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        {status !== null && (
          <p
            role="status"
            className={
              status.ok ? "text-success text-sm" : "text-destructive text-sm"
            }
          >
            {status.text}
          </p>
        )}
      </div>
    </form>
  );
};

/** Sanitized HTML from the domain (sanitized on save and again on read, RULE-133 replacement). */
export const SanitizedHtmlBlock = ({
  html,
  className,
}: {
  html: string | null;
  className?: string;
}) => {
  if (html === null || html === "") {
    return null;
  }

  return (
    <div
      className={className ?? "prose max-w-none"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export const nativeSelectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
