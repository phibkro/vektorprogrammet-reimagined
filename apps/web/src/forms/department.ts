import { DepartmentId, DepartmentInput } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import {
  Text,
  blankToNull,
  decimalOrNull,
  formSchema,
  isChecked,
  wholeNumber,
} from "./formSchema";

/**
 * C1: the department form, for create (a blank `id`) and for edit (an edit carries every stored field, the id, the
 * coordinates and the logo key, so saving never blanks one that the form does not show).
 */
export const DepartmentForm = formSchema(
  Schema.Struct({
    active: Text,
    address: Text,
    city: Text,
    email: Text,
    id: Text,
    latitude: Text,
    logoKey: Text,
    longitude: Text,
    name: Text,
    shortName: Text,
    slackChannel: Text,
  }),
  Schema.Struct({
    ...DepartmentInput.fields,
    id: Schema.NullOr(DepartmentId),
  }),
  (text) => ({
    active: isChecked(text.active),
    address: blankToNull(text.address),
    city: text.city ?? "",
    email: text.email ?? "",
    id: blankToNull(text.id) === null ? null : wholeNumber(text.id),
    latitude: decimalOrNull(text.latitude),
    logoKey: blankToNull(text.logoKey),
    longitude: decimalOrNull(text.longitude),
    name: text.name ?? "",
    shortName: text.shortName ?? "",
    slackChannel: blankToNull(text.slackChannel),
  })
);
