/**
 * The public footer, ported from mono-web's `AppFooter` (`apps/homepage/src/routes/_home.tsx`, commit 2aa6ce97):
 * the logo, the departments' Facebook pages, the way to the contact page, and the sponsors. Mono-web's sponsors,
 * address and e-mail were synthetic development content; here the sponsors are the CMS's (`sponsors`, large
 * first) and contact goes through `/kontakt`, so no address is written in the code.
 */
import { SiFacebook } from "@icons-pack/react-simple-icons";
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import { Mail } from "lucide-react";

import type { SponsorView } from "@/server/site/pages";

/** The departments' Facebook pages, from mono-web's footer; the department model has no social links yet. */
const FACEBOOK = [
  { city: "Trondheim", href: "https://www.facebook.com/vektorprogrammet/" },
  { city: "Ås", href: "https://www.facebook.com/vektorprogrammetNMBU/" },
  { city: "Bergen", href: "https://www.facebook.com/VektorprogrammetBergen/" },
] as const;

const LOGO_HEIGHT = {
  large: "h-16",
  medium: "h-12",
  small: "h-8",
} as const satisfies Record<SponsorView["size"], string>;

const Sponsors = ({
  sponsors,
}: {
  readonly sponsors: readonly SponsorView[];
}) =>
  sponsors.length === 0 ? null : (
    <section aria-labelledby="sponsors-heading" className="text-white">
      <h2 className="mb-2 font-bold" id="sponsors-heading">
        Sponsorer og samarbeidspartnere
      </h2>
      <ul className="flex flex-col gap-1">
        {Arr.map(sponsors, (sponsor) => (
          <li key={sponsor.url}>
            <a
              className="text-sm hover:underline"
              href={sponsor.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {sponsor.logo === null ? (
                sponsor.name
              ) : (
                <img
                  alt={sponsor.name}
                  className={`${LOGO_HEIGHT[sponsor.size]} w-auto rounded bg-white p-1`}
                  src={sponsor.logo.src}
                />
              )}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

export const SiteFooter = ({
  sponsors,
}: {
  readonly sponsors: readonly SponsorView[];
}) => (
  <footer className="bg-vektor-DARKblue">
    <div className="mx-auto flex max-w-6xl flex-col place-items-center justify-between space-y-8 p-2 py-8 lg:flex-row lg:space-y-0 lg:space-x-4">
      <img
        alt="Vektorprogrammet logo hvit"
        className="h-24 md:h-40"
        src="/images/vektor-logo-white.svg"
      />
      <div className="text-white">
        <ul className="grid grid-cols-1 gap-8">
          <li className="flex place-items-center space-x-4">
            <SiFacebook size={40} />
            <ul className="flex place-items-center space-x-2">
              {Arr.map(FACEBOOK, (page) => (
                <li key={page.city}>
                  <a className="hover:underline" href={page.href}>
                    {page.city}
                  </a>
                </li>
              ))}
            </ul>
          </li>
          <li className="flex place-items-center space-x-4">
            <Mail size={40} />
            <Link className="hover:underline" to="/kontakt">
              Kontakt oss
            </Link>
          </li>
        </ul>
      </div>
      <Sponsors sponsors={sponsors} />
    </div>
  </footer>
);
