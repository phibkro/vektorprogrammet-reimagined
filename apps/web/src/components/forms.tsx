import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { fieldErrors, type Outcome } from "@/lib/outcome";

type FieldErrors = Readonly<Record<string, ReadonlyArray<string>>>;

const FieldErrorsContext = createContext<FieldErrors>({});

/** Provides field messages (e.g. from a no-JavaScript re-render) to the `Field`s below it. */
export function FieldErrorsProvider({
  errors,
  children,
}: {
  errors: FieldErrors;
  children: ReactNode;
}) {
  return <FieldErrorsContext.Provider value={errors}>{children}</FieldErrorsContext.Provider>;
}

/**
 * A labelled control plus the messages for `name` (dotted path of a
 * `ValidationFailed` issue). The label wraps the control, so several forms on
 * one page need no unique ids.
 */
export function Field({
  name,
  label,
  children,
}: {
  name: string;
  label: string;
  children: ReactNode;
}) {
  const messages = useContext(FieldErrorsContext)[name] ?? [];
  return (
    <div className="grid gap-1.5">
      <Label className="grid gap-1.5">
        <span>{label}</span>
        {children}
      </Label>
      {messages.map((message) => (
        <p key={message} className="text-sm text-destructive">
          {message}
        </p>
      ))}
    </div>
  );
}

/**
 * A control-panel form backed by a server function that takes `FormData` and
 * answers an `Outcome` notice. On success the route's data is re-loaded.
 */
export function CommandForm({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const run = useServerFn(action);
  const [outcome, setOutcome] = useState<Outcome<string> | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [pending, setPending] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setCrashed(false);
    run({ data: new FormData(form) })
      .then((result) => {
        setOutcome(result);
        if (result._tag === "Success") {
          form.reset();
          return router.invalidate();
        }
      })
      .catch(() => {
        setOutcome(null);
        setCrashed(true);
      })
      .finally(() => setPending(false));
  };

  const status = crashed
    ? { ok: false, text: "Noe gikk galt. Prøv igjen senere." }
    : outcome === null
      ? null
      : outcome._tag === "Success"
        ? { ok: true, text: outcome.value }
        : { ok: false, text: outcome.message };

  return (
    <form onSubmit={onSubmit} className={className ?? "grid max-w-xl gap-4"}>
      <FieldErrorsProvider errors={fieldErrors(outcome)}>{children}</FieldErrorsProvider>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        {status !== null && (
          <p
            role="status"
            className={status.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}
          >
            {status.text}
          </p>
        )}
      </div>
    </form>
  );
}

/** Sanitized HTML from the domain (sanitized on save and again on read, RULE-133 replacement). */
export function SanitizedHtmlBlock({
  html,
  className,
}: {
  html: string | null;
  className?: string;
}) {
  if (html === null || html === "") return null;
  return (
    <div className={className ?? "prose max-w-none"} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export const nativeSelectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
