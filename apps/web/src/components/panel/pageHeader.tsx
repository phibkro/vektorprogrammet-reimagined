import type { ReactNode } from "react";

/** A control-panel page's title, what it holds, and the actions the actor may take on it. */
export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="flex flex-wrap items-start justify-between gap-4">
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description !== undefined && (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </div>
    {actions}
  </div>
);
