import { act } from "react";

/** Types `text` into `input` the way a user does: React reads the value from an input event, past its own tracker. */
export const typeInto = (input: HTMLInputElement, text: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  );

  act(() => {
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
