import { Schema } from "effect";

/** A form field as text; absent or a file becomes an empty string. */
export const text = (form: FormData, name: string): string => {
  const value = form.get(name);

  return Schema.is(Schema.String)(value) ? value : "";
};
