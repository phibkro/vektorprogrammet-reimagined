/**
 * Fake, same-shape fixtures. No real names, e-mail addresses or credentials:
 * e-mail domains are `.example`, ids are arbitrary.
 */
import {
  DepartmentId,
  EmailAddress,
  FileKey,
  PublicFileRepository,
  SlackChannel,
  UserId,
  type DepartmentDraft,
  type PublicFile,
  type Staff,
} from "@vektorprogrammet/domain";
import { DateTime, Effect } from "effect";

export const departmentDraft = (
  city: string,
  overrides: Partial<DepartmentDraft> = {},
): DepartmentDraft => ({
  name: `Vektor ${city}`,
  shortName: city.slice(0, 3).toUpperCase(),
  email: EmailAddress.make(`${city.toLowerCase()}@avdeling.example`),
  city,
  address: null,
  active: true,
  slackChannel: null,
  logoKey: null,
  latitude: null,
  longitude: null,
  ...overrides,
});

export const slackChannel = (name: string): SlackChannel => SlackChannel.make(`#${name}`);

/** A content-addressed key whose hash is `digit` repeated (valid shape, not a real hash). */
export const fileKey = (digit: string, extension: "png" | "jpg" | "pdf" = "png"): FileKey =>
  FileKey.make(`${digit.repeat(64)}.${extension}`);

export const AT = DateTime.makeUnsafe("2026-10-15T10:00:00.000Z");

export const publicFileFixture = (
  key: FileKey,
  overrides: Partial<PublicFile> = {},
): PublicFile => ({
  key,
  name: "bilde.png",
  contentType: "image/png",
  size: 1234,
  uploadedBy: null,
  legacyPath: null,
  uploadedAt: AT,
  ...overrides,
});

/** Registers image files so article and sponsor foreign keys resolve. */
export const registerImages = Effect.fnUntraced(function* (...keys: ReadonlyArray<FileKey>) {
  const files = yield* PublicFileRepository;
  yield* Effect.forEach(keys, (key) => files.register(publicFileFixture(key)), { discard: true });
});

export const staff = (overrides: Partial<Omit<Staff, "_tag">> = {}): Staff => ({
  _tag: "Staff",
  userId: UserId.make(9001),
  departmentId: DepartmentId.make(1),
  role: "admin",
  executiveBoard: false,
  ...overrides,
});
