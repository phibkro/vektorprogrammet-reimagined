/** What the content domain declares about its stored columns (spec 0007b): social events are published for their audience. */
import {
  columns,
  editorialReview,
  notPersonal,
  table,
} from "../../personal-data/domain/declaration.ts";

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

const siteContent = table({
  columns: {
    ...columns(
      editorialReview(
        "Editorial content can name people; an editor must review and remove matching material from both drafts and published content on request."
      ),
      ["draft", "published"]
    ),
    ...columns(notPersonal("Content identity and publication bookkeeping"), [
      "id",
      "collection",
      "slug",
      "created_at",
      "draft_published_at",
      "published_at",
    ]),
  },
  person: null,
});

export const ContentTables = {
  site_content: siteContent,
  social_event: socialEvent,
} as const;
