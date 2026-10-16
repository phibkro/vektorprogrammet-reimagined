/**
 * C6 sponsors: the sizes a sponsor has and the order the public footer shows them in. The sponsors themselves
 * (name, website, logo) are CMS entries (spec 0005).
 */
import { Array as Arr, Order, Schema } from "effect";

export const SponsorSize = Schema.Literals(["small", "medium", "large"]);

export type SponsorSize = typeof SponsorSize.Type;

const SIZE_RANK: Record<SponsorSize, number> = {
  large: 0,
  medium: 1,
  small: 2,
};

/** Footer order: large, then medium, then small; by name within a size. */
export const sortSponsorsForFooter = <
  S extends { readonly size: SponsorSize; readonly name: string },
>(
  sponsors: Iterable<S>
): S[] =>
  Arr.sort(
    sponsors,
    Order.combine(
      Order.mapInput(Order.Number, (sponsor: S) => SIZE_RANK[sponsor.size]),
      Order.mapInput(Order.String, (sponsor: S) => sponsor.name)
    )
  );
