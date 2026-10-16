/**
 * Fake, same-shape fixtures. No real names, e-mail addresses or credentials:
 * e-mail domains are `.example`, ids are arbitrary.
 */
import {
  Actor,
  DepartmentId,
  EmailAddress,
  FileKey,
  PublicFileRepository,
  SlackChannel,
  UserId,
} from "@vektorprogrammet/domain";
import type {
  DepartmentDraft,
  PublicFile,
  Staff,
} from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";

export const departmentDraft = (
  city: string,
  overrides: Partial<DepartmentDraft> = {}
): DepartmentDraft => ({
  active: true,
  address: null,
  city,
  email: EmailAddress.make(`${city.toLowerCase()}@avdeling.example`),
  latitude: null,
  logoKey: null,
  longitude: null,
  name: `Vektor ${city}`,
  shortName: city.slice(0, 3).toUpperCase(),
  slackChannel: null,
  ...overrides,
});

export const slackChannel = (name: string): SlackChannel =>
  SlackChannel.make(`#${name}`);

/** A content-addressed key whose hash is `digit` repeated (valid shape, not a real hash). */
export const fileKey = (
  digit: string,
  extension: "png" | "jpg" | "pdf" = "png"
): FileKey => FileKey.make(`${digit.repeat(64)}.${extension}`);

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

/** Registers image files so article and sponsor foreign keys resolve. */
export const registerImages = Effect.fnUntraced(function* registerImages(
  ...keys: readonly FileKey[]
) {
  const files = yield* PublicFileRepository;
  yield* Effect.forEach(keys, (key) => files.register(publicFileFixture(key)), {
    discard: true,
  });
});

export const staff = (overrides: Partial<Omit<Staff, "_tag">> = {}): Staff =>
  Actor.cases.Staff.make({
    departmentId: DepartmentId.make(1),
    executiveBoard: false,
    role: "admin",
    userId: UserId.make(9001),
    ...overrides,
  });
