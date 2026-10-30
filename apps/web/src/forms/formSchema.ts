/**
 * What every form of the app is built from (spec 0010a). A form reads the record that its inputs hold (every value is
 * text; a checkbox is `"on"` or absent, as in a `FormData`) and makes the typed payload of the domain command, by the
 * command's own payload schema after a text step: the rules and the Norwegian messages are the domain's. The browser
 * validates a form's values with `clientValidator`, and the server reads a posted `FormData` with the form's `read`;
 * both go through the same text step and the same payload schema, so the issues are the same.
 */
import { osloWallClock } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Predicate,
  Record as Rec,
  Schema,
  SchemaGetter,
} from "effect";

/** What a form's inputs hold: text, or nothing (an unchecked checkbox, a field a form does not render). */
export type FormText = Readonly<Record<string, string | undefined>>;

/** One input of a form: text, or nothing (an unchecked switch holds `undefined`); the schema of every value that a form holds. */
export const Text = Schema.optional(Schema.String);

/** `FormData` as the plain record the forms read: the last value of each name, text only. */
export const textOf = (form: FormData): FormText =>
  Rec.fromEntries(
    Arr.flatMap(Arr.fromIterable(form.keys()), (name) => {
      const value = form.get(name);

      return Predicate.isString(value) ? [[name, value] as const] : [];
    })
  );

/**
 * What a form's text step may make for a payload that encodes as `E`: the same shape, with each literal widened to its
 * kind (a team function is any text, a term any number), because a form holds what a person typed or chose and the
 * payload's schema is what refuses the rest, in the domain's words. A field that is missing or of another kind is a
 * compile error here, not a refusal at run time.
 */
export type Widen<E> = E extends string
  ? string
  : E extends number
    ? number
    : E extends boolean
      ? boolean
      : E extends readonly unknown[]
        ? E
        : E extends object
          ? { [K in keyof E]: Widen<E[K]> }
          : E;

/**
 * A form: what its inputs hold (`from`, every name optional text), the command payload it makes (`payload`, the
 * domain's own schema) and `map`, the text step between them (blank to null, digits to a number, an Oslo wall-clock
 * time to an instant). `map` makes `payload`'s encoded form; `payload` decides what is valid, in the domain's words.
 * `schema` is the browser's: the values of the inputs in, the payload out. `read` is the server's: a posted `FormData`
 * in, the payload's encoded form out (`payloadOf` is the same step for values that were read already), which the
 * command's endpoint (`Commands.endpoint`) decodes with the same `payload`, so the two cannot disagree about what is
 * valid.
 */
export const formSchema = <
  From extends Schema.Constraint & {
    readonly Encoded: FormText;
    readonly Type: FormText;
  },
  To extends Schema.Constraint,
>(
  from: From,
  payload: To,
  map: (text: FormText) => Widen<To["Encoded"]>
) => ({
  payloadOf: map,
  read: (form: FormData): Widen<To["Encoded"]> => map(textOf(form)),
  schema: Schema.decodeTo(payload)(
    Schema.decodeTo<typeof Schema.Unknown, From>(Schema.Unknown, {
      decode: SchemaGetter.transform(map),
      encode: SchemaGetter.forbidden(() => "A form is only decoded."),
    })(from)
  ),
});

/** The client's validator for a form: Standard Schema over the form schema, every issue at once. */
export const clientValidator = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
) => {
  const standard = Schema.toStandardSchemaV1(schema, {
    parseOptions: { errors: "all" },
  });

  return { "~standard": standard["~standard"] };
};

/** The `FormData` that a form posts: a value that is `undefined` is left out, as an unchecked checkbox is. */
export const toFormData = (values: FormText): FormData => {
  const form = new FormData();

  for (const name of Rec.keys(values)) {
    const value = values[name];

    if (value !== undefined) {
      form.set(name, value);
    }
  }

  return form;
};

/** Blank text is nothing: the text step of an optional field. */
export const blankToNull = (value: string | undefined): string | null => {
  const trimmed = (value ?? "").trim();

  return trimmed === "" ? null : trimmed;
};

/** Whether a posted form holds something under `name`: a form that creates or changes tells which by its `id`. */
export const hasValue = (form: FormData, name: string): boolean =>
  blankToNull(textOf(form)[name]) !== null;

/** A checkbox: present is true. */
export const isChecked = (value: string | undefined): boolean =>
  value !== undefined;

/** Whole digits are a number; any other text is `NaN`, which the domain's number schema refuses in its own words. */
export const wholeNumber = (value: string | undefined): number => {
  const text = (value ?? "").trim();

  return /^-?\d+$/u.test(text) ? Number(text) : Number.NaN;
};

/** An optional decimal (a comma is a point): blank is nothing, other text that is no number is `NaN`. */
export const decimalOrNull = (value: string | undefined): number | null => {
  const text = blankToNull(value);

  return text === null ? null : Number(text.replace(",", "."));
};

const LOCAL_TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/u;

/**
 * `<input type="datetime-local">` holds Oslo wall-clock time; the domain wants a UTC instant. Text that is no such time
 * is handed on as it is, and the domain's schema refuses it.
 */
export const osloLocalToIso = (value: string | undefined): string => {
  const text = (value ?? "").trim();
  const match = LOCAL_TIME.exec(text);

  if (match === null) {
    return text;
  }

  const [, year, month, day, hour, minute] = Arr.map(match, Number);

  return DateTime.formatIso(osloWallClock({ day, hour, minute, month, year }));
};
