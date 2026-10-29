/**
 * Fake, same-shape fixtures. No real names, e-mail addresses or credentials:
 * e-mail domains are `.example`, ids are arbitrary.
 */
import {
  EmailAddress,
  FileKey,
  OutboxMessage,
  SlackChannel,
  SlackTarget,
} from "@vektorprogrammet/domain";
import type { DepartmentDraft, PublicFile } from "@vektorprogrammet/domain";
import { DateTime, String as Str } from "effect";

export const departmentDraft = (
  city: string,
  overrides: Partial<DepartmentDraft> = {}
): DepartmentDraft => ({
  active: true,
  address: null,
  city,
  email: EmailAddress.make(`${Str.toLowerCase(city)}@avdeling.example`),
  latitude: null,
  logoKey: null,
  longitude: null,
  name: `Vektor ${city}`,
  shortName: Str.toUpperCase(Str.slice(0, 3)(city)),
  slackChannel: null,
  ...overrides,
});

export const slackChannel = (name: string): SlackChannel =>
  SlackChannel.make(`#${name}`);

/** A Slack post to the notifications channel: the smallest outbox message. */
export const slack = (text: string): OutboxMessage =>
  OutboxMessage.cases.SlackPost.make({
    target: SlackTarget.cases.Notifications.make({}),
    text,
  });

/** A content-addressed key whose hash is `digit` repeated (valid shape, not a real hash). */
export const fileKey = (
  digit: string,
  extension: "png" | "jpg" | "pdf" = "png"
): FileKey => FileKey.make(`${Str.repeat(64)(digit)}.${extension}`);

export const AT = DateTime.makeUnsafe("2026-10-15T10:00:00.000Z");

export const publicFileFixture = (
  key: FileKey,
  overrides: Partial<PublicFile> = {}
): PublicFile => ({
  contentType: "image/png",
  key,
  legacyPath: null,
  name: "bilde.png",
  size: 1234,
  uploadedAt: AT,
  uploadedBy: null,
  ...overrides,
});
