import { Array as Arr, Predicate } from "effect";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useLayoutEffect,
} from "react";
import type {
  ChangeEvent,
  ComponentType,
  ReactElement,
  ReactNode,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formLevelMessage } from "@/lib/outcome";
import type { FieldErrors, Outcome } from "@/lib/outcome";

/** A `Field` tells the form it is rendered, and gets back the call that tells it the `Field` is gone. */
export type RegisterField = (name: string) => () => void;

export const RegisterFieldContext = createContext<RegisterField | null>(null);

/** The messages that the server put on each field (a validation issue of a command), by dotted path. */
export const ServerIssuesContext = createContext<FieldErrors>({});

const CONTROL_TAGS: readonly string[] = ["input", "select", "textarea"];

interface ControlProps {
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean;
  readonly checked?: boolean;
  readonly name?: string;
  readonly onBlur?: () => void;
  readonly onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly value?: string;
}

/** A form control (a native one or a component), not a `div` or `p` that stands in for one. */
const isControl = (element: ReactElement): boolean =>
  !Predicate.isString(element.type) || Arr.contains(CONTROL_TAGS, element.type);

/** What TanStack keeps as a field's error: a Standard Schema issue (its text is `message`) or plain text. */
type FieldError =
  | string
  | { readonly message?: string | undefined }
  | null
  | undefined;

const messageOf = (error: FieldError): string => {
  if (Predicate.isString(error)) {
    return error;
  }

  return error?.message ?? "";
};

/**
 * A form field as TanStack hands it to its render function: the parts of it that a control needs. It is the one place
 * that reads TanStack's field state, so a control never does.
 */
interface FieldState {
  readonly handleBlur: () => void;
  readonly handleChange: (value: string | undefined) => void;
  readonly name: string;
  readonly state: {
    readonly meta: { readonly errors: readonly FieldError[] };
    readonly value: string | undefined;
  };
}

const isToggle = (control: ReactNode): boolean =>
  isValidElement(control) &&
  (control.type === Switch || control.type === Checkbox);

/** What a control is marked with while its field has messages: invalid, and described by them. */
const marks = (
  control: ReactElement<ControlProps>,
  messagesId: string | null
): ControlProps => {
  if (messagesId === null) {
    return {};
  }

  const existing = control.props["aria-describedby"];

  return {
    "aria-describedby": Predicate.isString(existing)
      ? `${existing} ${messagesId}`
      : messagesId,
    "aria-invalid": true,
  };
};

/**
 * The control, bound to the field and marked invalid and described by the messages `id`, when it is one control. A
 * `Switch` or a `Checkbox` holds `"on"` or nothing, as a checkbox of a posted form does; any other control holds its
 * text.
 */
const bound = (
  control: ReactNode,
  field: FieldState,
  messagesId: string | null
): ReactNode => {
  if (!isValidElement<ControlProps>(control) || !isControl(control)) {
    return control;
  }

  if (isToggle(control)) {
    return cloneElement(control, {
      ...marks(control, messagesId),
      checked: field.state.value !== undefined,
      onCheckedChange: (checked: boolean) => {
        field.handleChange(checked ? "on" : undefined);
      },
    });
  }

  return cloneElement(control, {
    ...marks(control, messagesId),
    name: field.name,
    onBlur: field.handleBlur,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      field.handleChange(event.target.value);
    },
    value: field.state.value ?? "",
  });
};

const FieldBody = ({
  children,
  field,
  label,
}: {
  children: ReactNode;
  field: FieldState;
  label: string;
}) => {
  const server = useContext(ServerIssuesContext)[field.name] ?? [];
  const register = useContext(RegisterFieldContext);
  const messagesId = useId();

  const messages = Arr.dedupe([
    ...Arr.filter(
      Arr.map(field.state.meta.errors, messageOf),
      (text) => text !== ""
    ),
    ...server,
  ]);

  useLayoutEffect(() => register?.(field.name), [register, field.name]);

  const described = messages.length === 0 ? null : messagesId;
  const toggle = isToggle(children);

  return (
    <div className="grid gap-1.5">
      {toggle ? (
        <label className="flex items-center gap-2 text-sm font-medium">
          {bound(children, field, described)}
          {label}
        </label>
      ) : (
        <Label className="grid">
          <span className="mb-1.5">{label}</span>
          {bound(children, field, described)}
        </Label>
      )}
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

export type FieldComponent<Values> = (props: {
  children: ReactNode;
  label: string;
  name: keyof Values & string;
}) => ReactElement;

/** What of TanStack's form a `Field` needs: its own `Field` component. The form holds text under any name. */
export interface BoundForm {
  readonly Field: ComponentType<{
    readonly children: (field: FieldState) => ReactNode;
    readonly name: string;
  }>;
}

/**
 * A labelled control bound to one value of the form, plus the messages for it: the browser's own (the schema's issues
 * at this path) and the server's (a validation issue of a command at this path). The label wraps the control, so several
 * forms on one page need no unique ids; the messages have one, which the control names in `aria-describedby` beside
 * `aria-invalid`. It also tells the form it is on screen, so an issue on any other path is the form's own message.
 */
export const boundField =
  <Values,>(form: BoundForm): FieldComponent<Values> =>
  ({ children, label, name }) => (
    <form.Field name={name}>
      {(field: FieldState) => (
        <FieldBody field={field} label={label}>
          {children}
        </FieldBody>
      )}
    </form.Field>
  );

/**
 * What a form shows of one outcome besides the field messages: every other message (a refusal, a duplicate, an issue
 * on a hidden input or on no path) in one alert. Which paths have a `Field` is what the `Field`s say they render now,
 * not a list the page repeats (issue 26).
 */
export const FormAlert = ({
  crashed,
  outcome,
  shown,
}: {
  crashed: boolean;
  outcome: Outcome<unknown> | null;
  shown: ReadonlySet<string>;
}) => {
  const problem = crashed
    ? "Noe gikk galt. Prøv igjen senere."
    : formLevelMessage(outcome, shown);

  return (
    problem !== null && (
      <Alert variant="destructive">
        <AlertDescription>{problem}</AlertDescription>
      </Alert>
    )
  );
};
