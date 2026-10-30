import { Content, Organisation } from "@vektorprogrammet/domain";
import { Schema } from "effect";

import {
  Text,
  blankToNull,
  formSchema,
  osloLocalToIso,
  wholeNumber,
} from "./formSchema";

/** A field of study in a department. */
export const CreateFieldOfStudyForm = formSchema(
  Schema.Struct({ departmentId: Text, name: Text, shortName: Text }),
  Organisation.createFieldOfStudy.payloadSchema,
  (text) => ({
    departmentId: wholeNumber(text.departmentId),
    name: text.name ?? "",
    shortName: text.shortName ?? "",
  })
);

/** A field of study that is given new names. */
export const RenameFieldOfStudyForm = formSchema(
  Schema.Struct({ id: Text, name: Text, shortName: Text }),
  Organisation.updateFieldOfStudy.payloadSchema,
  (text) => ({
    id: wholeNumber(text.id),
    name: text.name ?? "",
    shortName: text.shortName ?? "",
  })
);

/** C8: one social event; its times are Oslo wall-clock time. */
export const SocialEventForm = formSchema(
  Schema.Struct({
    departmentId: Text,
    description: Text,
    endsAt: Text,
    link: Text,
    semesterId: Text,
    startsAt: Text,
    title: Text,
  }),
  Content.createSocialEvent.payloadSchema,
  (text) => ({
    departmentId: wholeNumber(text.departmentId),
    description: text.description ?? "",
    endsAt: osloLocalToIso(text.endsAt),
    link: blankToNull(text.link),
    semesterId: wholeNumber(text.semesterId),
    startsAt: osloLocalToIso(text.startsAt),
    title: text.title ?? "",
  })
);

/** A command that asks nothing: a button and a sentence. */
export const NoFieldsForm = formSchema(
  Schema.Struct({}),
  Schema.Struct({}),
  () => ({})
);
