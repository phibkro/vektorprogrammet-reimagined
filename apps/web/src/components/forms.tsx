import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Array as Arr, Effect, Predicate } from "effect";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { fieldErrors, formLevelMessage } from "@/lib/outcome";
import type { Outcome } from "@/lib/outcome";

type FieldErrors = Readonly<Record<string, readonly string[]>>;

const FieldErrorsContext = createContext<FieldErrors>({});

/** A `Field` tells the form it is rendered, and gets back the call that tells it the `Field` is gone. */
type RegisterField = (name: string) => () => void;

const RegisterFieldContext = createContext<RegisterField | null>(null);

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

const CONTROL_TAGS: readonly string[] = ["input", "select", "textarea"];

interface ControlProps {
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean;
}

/** A form control (a native one or a component), not a `div` or `p` that stands in for one. */
const isControl = (element: ReactElement): boolean =>
  !Predicate.isString(element.type) || Arr.contains(CONTROL_TAGS, element.type);

/** The control, marked invalid and described by the messages `id`, when it is one control. */
const describedBy = (control: ReactNode, id: string): ReactNode => {
  if (!isValidElement<ControlProps>(control) || !isControl(control)) {
    return control;
  }

  const existing = control.props["aria-describedby"];

  return cloneElement(control, {
    "aria-describedby": Predicate.isString(existing) ? `${existing} ${id}` : id,
    "aria-invalid": true,
  });
};

/**
 * A labelled control plus the messages for `name` (dotted path of a
 * `ValidationFailed` issue). The label wraps the control, so several forms on
 * one page need no unique ids; the messages have one, which the control names in
 * `aria-describedby` beside `aria-invalid`. Inside a `CommandForm` it also tells
 * the form it is on screen, so an issue on any other path is the form's own message.
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
  const register = useContext(RegisterFieldContext);
  const messagesId = useId();

  useLayoutEffect(() => register?.(name), [register, name]);

  return (
    <div className="grid gap-1.5">
      <Label className="grid">
        <span className="mb-1.5">{label}</span>
        {messages.length === 0 ? children : describedBy(children, messagesId)}
      </Label>
      {messages.length > 0 && (
        <div className="grid gap-1.5" id={messagesId}>
          {Arr.map(messages, (message) => (
            <p key={message} className="text-destructive text-sm">
              {message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};

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
 * What a form shows of one outcome: each validation issue under the `Field` of its path, and every other
 * message (a refusal, a duplicate, an issue on a hidden input or on no path) in one alert. Which paths have a
 * `Field` is what the `Field`s say they render now, not a list the page repeats, so it follows `children` when
 * its fields change while the outcome stays (issue 26).
 */
export const OutcomeMessages = ({
  outcome,
  crashed = false,
  children,
}: {
  outcome: Outcome<unknown> | null;
  crashed?: boolean;
  children: ReactNode;
}) => {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());

  const register = useCallback<RegisterField>((name) => {
    setCounts((current) => countField(current, name, 1));

    return () => {
      setCounts((current) => countField(current, name, -1));
    };
  }, []);

  const shownFields = useMemo(() => new Set(counts.keys()), [counts]);

  const problem = crashed
    ? "Noe gikk galt. Prøv igjen senere."
    : formLevelMessage(outcome, shownFields);

  return (
    <>
      <RegisterFieldContext.Provider value={register}>
        <FieldErrorsProvider errors={fieldErrors(outcome)}>
          {children}
        </FieldErrorsProvider>
      </RegisterFieldContext.Provider>
      {problem !== null && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </>
  );
};

/**
 * A control-panel form backed by a server function that takes `FormData` and
 * answers an `Outcome` notice. On success the route's data is re-loaded and
 * `onSuccess` runs (a dialog closes). A failure stays on screen: validation
 * messages under their field, every other refusal (403, a duplicate) in an alert, and so is a
 * validation issue on a field the form does not render (a hidden `id`, issue 26): `OutcomeMessages`.
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

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className={className ?? "grid max-w-xl gap-4"}
    >
      <OutcomeMessages outcome={outcome} crashed={crashed}>
        {children}
      </OutcomeMessages>
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
