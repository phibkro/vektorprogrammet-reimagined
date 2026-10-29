/**
 * The public header, ported from mono-web's `AppHeader` (`apps/homepage/src/routes/_home.tsx`, commit 2aa6ce97):
 * a pill with the logo and the eight tabs on wide screens, and a menu button with a drawer on narrow ones. The
 * active tab is a pill drawn in CSS, so the server renders it in place (mono-web slid a measured indicator in
 * with `motion` after hydration).
 * Sign-in is available separately from the public navigation tabs.
 */
import { Dialog } from "@base-ui/react/dialog";
import { Link, useLocation } from "@tanstack/react-router";
import { Array as Arr, Option, String as Str } from "effect";
import { useState } from "react";

import { cn } from "@/lib/utils";

const NAV = [
  { name: "Hjem", to: "/" },
  { name: "Om oss", to: "/om-oss" },
  { name: "Assistenter", to: "/assistenter" },
  { name: "Team", to: "/team" },
  { name: "Foreldre", to: "/foreldre" },
  { name: "Skoler", to: "/skoler" },
  { name: "Nyheter", to: "/nyheter" },
  { name: "Kontakt", to: "/kontakt" },
] as const;

type NavItem = (typeof NAV)[number];

/** The tab a path belongs to: its own subtree, and an article belongs to Nyheter. */
export const activeTab = (pathname: string): Option.Option<NavItem> =>
  Arr.findFirst(NAV, (item) => {
    if (item.to === "/") {
      return pathname === "/";
    }

    const section = item.to === "/nyheter" ? ["/nyheter", "/nyhet"] : [item.to];

    return Arr.some(
      section,
      (prefix) => pathname === prefix || Str.startsWith(`${prefix}/`)(pathname)
    );
  });

const NavTabs = () => {
  const { pathname } = useLocation();
  const active = activeTab(pathname);

  return (
    <nav aria-label="Hovedmeny" className="flex h-11 px-0.5">
      {Arr.map(NAV, (item) => (
        <Link
          className={cn(
            "my-1.5 place-content-center rounded-full px-4 text-center text-sm font-medium transition-colors",
            Option.exists(active, (current) => current.to === item.to)
              ? "bg-vektor-blue text-black shadow-sm"
              : "text-vektor-nav hover:text-black"
          )}
          key={item.to}
          preload="intent"
          to={item.to}
        >
          {item.name}
        </Link>
      ))}
    </nav>
  );
};

const MobileMenu = () => {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <Dialog.Root onOpenChange={setOpen} open={open}>
        <Dialog.Trigger
          aria-label="Åpne meny"
          className="fixed top-12 right-0 z-50 flex size-12 items-center justify-center rounded-l-full bg-black/80 p-1 pr-2"
        >
          <img
            alt=""
            className="size-full rounded-full object-cover"
            src="/images/team/IT-Tor.png"
          />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Popup className="public-site fixed inset-x-0 bottom-0 z-50 rounded-t-2xl p-6 shadow-lg">
            <Dialog.Title className="sr-only">Meny</Dialog.Title>
            <ul className="flex flex-col items-start gap-4">
              {Arr.map(NAV, (item) => (
                <li key={item.to}>
                  <Link
                    className="text-vektor-DARKblue text-lg"
                    onClick={() => {
                      setOpen(false);
                    }}
                    to={item.to}
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  className="text-vektor-DARKblue text-lg"
                  onClick={() => {
                    setOpen(false);
                  }}
                  to="/logg-inn"
                >
                  Logg inn
                </Link>
              </li>
            </ul>
            <Dialog.Close className="mt-6 rounded-md border px-4 py-2 text-sm">
              Lukk
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
};

export const SiteHeader = () => (
  <header className="sticky top-2 z-40">
    <div className="hidden w-full flex-wrap justify-center md:flex lg:px-4">
      <div className="bg-vektor-light-blue/40 flex w-fit items-center gap-1 rounded-full px-1.5 shadow-md backdrop-blur">
        <img
          alt="Vektorprogrammet logo"
          height={32}
          src="/images/vektor-logo-circle.svg"
          width={32}
        />
        <NavTabs />
        <Link className="rounded-full px-4 text-sm font-medium" to="/logg-inn">
          Logg inn
        </Link>
      </div>
    </div>
    <MobileMenu />
  </header>
);
