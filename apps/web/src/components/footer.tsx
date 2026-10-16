import { Array as Arr, pipe } from "effect";

import type { SponsorView } from "@/server/pages";

const LOGO_HEIGHT: Record<SponsorView["size"], string> = {
  large: "h-16",
  medium: "h-12",
  small: "h-8",
};

/** C6: sponsors by size (large first), from listSponsorsForFooter. */
const Footer = ({ sponsors }: { sponsors: readonly SponsorView[] }) => (
  <footer className="border-line text-sea-ink-soft mt-20 border-t px-4 pt-10 pb-14">
    <div className="page-wrap grid gap-6">
      {sponsors.length > 0 && (
        <section
          aria-label="Sponsorer"
          className="flex flex-wrap items-center justify-center gap-6"
        >
          {pipe(
            sponsors,
            Arr.map((sponsor) => (
              <a
                key={sponsor.url}
                href={sponsor.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {sponsor.logoKey === null ? (
                  <span className="text-sm font-semibold">{sponsor.name}</span>
                ) : (
                  <img
                    src={`/filer/${sponsor.logoKey}`}
                    alt={sponsor.name}
                    className={`${LOGO_HEIGHT[sponsor.size]} w-auto`}
                  />
                )}
              </a>
            ))
          )}
        </section>
      )}
      <p className="m-0 text-center text-sm">
        Vektorprogrammet · frivillig leksehjelp i matematikk
      </p>
    </div>
  </footer>
);

export default Footer;
