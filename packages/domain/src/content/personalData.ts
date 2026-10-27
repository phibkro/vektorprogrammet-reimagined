/** What the content domain declares about its stored columns (spec 0007b): social events are published for their audience. */
import { columns, notPersonal, table } from "../personalData/declaration.ts";

const socialEvent = table({
  columns: columns(
    notPersonal(
      "An event that a department publishes for its audience; it holds no data about a person"
    ),
    [
      "department_id",
      "description",
      "ends_at",
      "id",
      "link",
      "semester_id",
      "starts_at",
      "title",
    ]
  ),
  person: null,
});

export const ContentTables = { social_event: socialEvent } as const;
