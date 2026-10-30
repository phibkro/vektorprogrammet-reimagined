import type { Schema } from "effect";
import { useRef } from "react";
import type { ReactNode } from "react";

import type { FormText } from "@/forms/formSchema";
import type { FieldErrors } from "@/lib/outcome";

import { ServerIssuesContext } from "./field";
import type { FieldComponent } from "./field";
import { useConstructForm } from "./useConstructForm";

/**
 * A form that posts to a URL of its own (spec 0010a): the contact form, the reset request, the code form. It is a
 * plain `<form method="post">` that works without JavaScript, as those forms do (RULE-156, RULE-167); the server
 * answers a failure by rendering the page again with the visitor's values (`defaults`) and the command's issues
 * (`serverIssues`). With JavaScript the same schema validates the values first and shows the domain's messages under
 * the fields, and a valid form is then posted by the browser as it would be without: nothing is sent that the
 * markup would not have sent.
 */
export const PostForm = <
  S extends Schema.ConstraintDecoder<unknown> & { readonly Encoded: FormText },
>({
  action,
  children,
  className,
  defaults,
  id,
  schema,
  serverIssues,
}: {
  action?: string;
  children: (Field: FieldComponent<S["Encoded"]>) => ReactNode;
  className?: string;
  defaults: S["Encoded"];
  id?: string;
  schema: S;
  serverIssues: FieldErrors;
}) => {
  const element = useRef<HTMLFormElement>(null);

  const { Field, onSubmit } = useConstructForm({
    defaults,
    onValid: () => {
      element.current?.submit();
    },
    schema,
  });

  return (
    <form
      action={action}
      className={className}
      id={id}
      method="post"
      onSubmit={onSubmit}
      ref={element}
    >
      <ServerIssuesContext.Provider value={serverIssues}>
        {children(Field)}
      </ServerIssuesContext.Provider>
    </form>
  );
};
