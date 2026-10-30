import type { Schema } from "effect";
import type { ReactNode } from "react";

import type { FormText } from "@/forms/formSchema";

import type { FieldComponent } from "./field";
import { useConstructForm } from "./useConstructForm";

/**
 * A form whose valid values go to a client library instead of a server function (spec 0010a): the two Better Auth
 * forms, sign-in and change password. The schema validates the values, the same way as in every other form of the app;
 * `onValid` gets only values that pass, and what the library answers is the page's to show.
 */
export const LocalForm = <
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
>({
  children,
  className,
  defaults,
  onValid,
  schema,
}: {
  children: (Field: FieldComponent<S["Encoded"]>) => ReactNode;
  className?: string;
  defaults: S["Encoded"];
  onValid: (values: FormText) => void;
  schema: S;
}) => {
  const { Field, onSubmit } = useConstructForm({
    defaults,
    onValid: (values) => {
      onValid(values);
    },
    schema,
  });

  return (
    <form className={className} noValidate onSubmit={onSubmit}>
      {children(Field)}
    </form>
  );
};
