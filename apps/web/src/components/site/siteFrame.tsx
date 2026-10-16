import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site/siteFooter";
import { SiteHeader } from "@/components/site/siteHeader";
import type { SponsorView } from "@/server/site/pages";

/** The header, the page and the footer on mono-web's plain white page (`.public-site`). */
export const SiteFrame = ({
  children,
  sponsors,
}: {
  readonly children: ReactNode;
  readonly sponsors: readonly SponsorView[];
}) => (
  <div className="public-site flex min-h-screen flex-col items-stretch">
    <SiteHeader />
    {children}
    <SiteFooter sponsors={sponsors} />
  </div>
);
