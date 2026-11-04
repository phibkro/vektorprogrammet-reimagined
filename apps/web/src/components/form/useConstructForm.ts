import { useForm } from "@tanstack/react-form";
import type { Schema } from "effect";
import { useCallback, useMemo } from "react";
import type { SyntheticEvent } from "react";

import { clientValidator } from "@/forms/formSchema";
import type { FormText } from "@/forms/formSchema";

import { boundField } from "./field";

/**
 * The one place a form of the app is built on TanStack Form (spec 0010a): the values start as `defaults`, the form's
 * `schema` validates them when the form is submitted (the domain's messages, every issue at once), and only values
 * that pass reach `onValid`. `Field` is bound to this form's value names; `onSubmit` is the handler of the form element. The
 * forms differ in what a valid submission does (`CommandForm` calls a server function, `PostForm` lets the browser
 * post, `LocalForm` calls a client library), and in nothing else.
 */
export const useConstructForm = <
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
>({
  defaults,
  onRefused,
  onValid,
  schema,
}: {
  defaults: S["Encoded"];
  /** Runs when the schema refuses the values, before any message shows: what an earlier answer said no longer holds. */
  onRefused?: () => void;
  onValid: (values: FormText, reset: () => void) => Promise<void> | void;
  schema: S;
}) => {
  const initial: FormText = defaults;

  const form = useForm({
    defaultValues: initial,
    onSubmit: ({ formApi, value }) =>
      onValid(value, () => {
        formApi.reset();
      }),
    onSubmitInvalid: () => {
      onRefused?.();
    },
    validators: { onSubmit: clientValidator(schema) },
  });

  const Field = useMemo(() => boundField<S["Encoded"]>(form), [form]);

  const onSubmit = useCallback(
    (event: SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void form.handleSubmit();
    },
    [form]
  );

  return { Field, form, onSubmit };
};
