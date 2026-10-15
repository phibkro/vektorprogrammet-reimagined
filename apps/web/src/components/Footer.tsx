import type { SponsorView } from "@/server/pages";

const LOGO_HEIGHT: Record<SponsorView["size"], string> = {
  large: "h-16",
  medium: "h-12",
  small: "h-8",
};

/** C6: sponsors by size (large first), from `listSponsorsForFooter`. */
export default function Footer({ sponsors }: { sponsors: ReadonlyArray<SponsorView> }) {
  return (
    <footer className="mt-20 border-t border-[var(--line)] px-4 pb-14 pt-10 text-[var(--sea-ink-soft)]">
      <div className="page-wrap grid gap-6">
        {sponsors.length > 0 && (
          <section
            aria-label="Sponsorer"
            className="flex flex-wrap items-center justify-center gap-6"
          >
            {sponsors.map((sponsor) => (
              <a key={sponsor.url} href={sponsor.url} rel="noopener noreferrer" target="_blank">
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
            ))}
          </section>
        )}
        <p className="m-0 text-center text-sm">
          Vektorprogrammet · frivillig leksehjelp i matematikk
        </p>
      </div>
    </footer>
  );
}
