/** C6 sponsors (RULE-189), shown in the footer by size. */
import { Array as Arr, Order, Schema } from "effect";

import { FileKey, SponsorId } from "../shared/ids.ts";
import {
  HttpUrl,
  REQUIRED_FIELD_MESSAGE,
  requiredText,
} from "../shared/validation.ts";

export const SponsorSize = Schema.Literals(["small", "medium", "large"]);

export type SponsorSize = typeof SponsorSize.Type;

export const Sponsor = Schema.Struct({
  id: SponsorId,
  logoKey: Schema.NullOr(FileKey),
  name: Schema.String.check(Schema.isNonEmpty()),
  size: SponsorSize,
  url: HttpUrl,
});

export type Sponsor = typeof Sponsor.Type;

export type SponsorDraft = Omit<Sponsor, "id">;

/**
 * RULE-189: name, website and size are required ('Feletet kan ikke være
 * tomt.'). Fixed legacy defects: the URL must be an absolute http(s) URL, and
 * the logo must be a registered image (checked by the command).
 */
export const SponsorInput = Schema.Struct({
  logoKey: Schema.NullOr(FileKey),
  name: requiredText({ maxLength: 50 }).annotateKey({
    messageMissingKey: REQUIRED_FIELD_MESSAGE,
  }),
  size: SponsorSize.annotate({ message: REQUIRED_FIELD_MESSAGE }).annotateKey({
    messageMissingKey: REQUIRED_FIELD_MESSAGE,
  }),
  url: requiredText({ maxLength: 255 })
    .pipe(Schema.decodeTo(HttpUrl))
    .annotateKey({ messageMissingKey: REQUIRED_FIELD_MESSAGE }),
});

export type SponsorInput = typeof SponsorInput.Type;

const SIZE_RANK: Record<SponsorSize, number> = {
  large: 0,
  medium: 1,
  small: 2,
};

/** Footer order: large, then medium, then small; by name within a size. */
export const sortSponsorsForFooter = <S extends Pick<Sponsor, "size" | "name">>(
  sponsors: Iterable<S>
): S[] =>
  Arr.sort(
    sponsors,
    Order.combine(
      Order.mapInput(Order.Number, (sponsor: S) => SIZE_RANK[sponsor.size]),
      Order.mapInput(Order.String, (sponsor: S) => sponsor.name)
    )
  );
