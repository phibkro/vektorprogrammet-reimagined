import { Link } from "@tanstack/react-router";

const NAV = [
  { to: "/", label: "Hjem" },
  { to: "/omvektor", label: "Om Vektor" },
  { to: "/foreldre", label: "Foreldre" },
  { to: "/nyheter", label: "Nyheter" },
  { to: "/kontakt", label: "Kontakt" },
] as const;

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--header-bg)] px-4 backdrop-blur-lg">
      <nav className="page-wrap flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <Link
          to="/"
          className="mr-auto text-base font-bold tracking-tight text-[var(--sea-ink)] no-underline"
        >
          Vektorprogrammet
        </Link>
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="nav-link text-sm font-semibold"
            activeProps={{ className: "nav-link is-active text-sm font-semibold" }}
            activeOptions={{ exact: item.to === "/" }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
