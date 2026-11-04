import type { Schema } from "effect";
import type { ReactNode } from "react";

import type { FormText } from "@/forms/formSchema";

import type { FieldComponent } from "./field";
import { useConstructForm } from "./useConstructForm";

/**
 * A form whose valid values go to a client library instead of a server function.
 * The schema validates values before the page passes them to the provider.
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
    <form className={className} method="post" noValidate onSubmit={onSubmit}>
      {children(Field)}
    </form>
  );
};
