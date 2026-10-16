import { Link } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

const NAV = [
  { label: "Hjem", to: "/" },
  { label: "Om Vektor", to: "/omvektor" },
  { label: "Foreldre", to: "/foreldre" },
  { label: "Nyheter", to: "/nyheter" },
  { label: "Kontakt", to: "/kontakt" },
] as const;

const Header = () => (
  <header className="border-line bg-header-bg sticky top-0 z-50 border-b px-4 backdrop-blur-lg">
    <nav className="page-wrap flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <Link
        to="/"
        className="text-sea-ink mr-auto text-base font-bold tracking-tight no-underline"
      >
        Vektorprogrammet
      </Link>
      {pipe(
        NAV,
        Arr.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="nav-link text-sm font-semibold"
            activeProps={{
              className: "nav-link is-active text-sm font-semibold",
            }}
            activeOptions={{ exact: item.to === "/" }}
          >
            {item.label}
          </Link>
        ))
      )}
    </nav>
  </header>
);

export default Header;
