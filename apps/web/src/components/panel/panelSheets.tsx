import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { CommandForm } from "@/components/forms";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { Outcome } from "@/lib/outcome";

interface SheetFrame {
  /** The control that opens the Sheet, as an element (`<Button size="sm" />`); its label is `triggerLabel`. */
  trigger: ReactElement;
  triggerLabel: string;
  title: string;
  description?: string;
}

/**
 * A Sheet that slides in from the right (Base UI: the trigger takes its element through `render`). Escape, the
 * close button and a click outside close it, and focus returns to the trigger.
 */
const PanelSheet = ({
  trigger,
  triggerLabel,
  title,
  description,
  open,
  onOpenChange,
  children,
}: SheetFrame & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) => (
  <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetTrigger render={trigger}>{triggerLabel}</SheetTrigger>
    <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{title}</SheetTitle>
        {description !== undefined && (
          <SheetDescription>{description}</SheetDescription>
        )}
      </SheetHeader>
      {children}
    </SheetContent>
  </Sheet>
);

/**
 * A control-panel form in a Sheet. It closes when the command succeeded and the page data was reloaded, so the
 * table behind it already shows the change; a refusal stays in the Sheet, with its message, and nothing is saved.
 */
export const CommandSheet = ({
  action,
  submitLabel,
  children,
  defaultOpen = false,
  ...frame
}: SheetFrame & {
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
  submitLabel: string;
  children: ReactNode;
  /** Open on first render: the extend link of the "ending soon" e-mail opens the form it names. */
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <PanelSheet {...frame} open={open} onOpenChange={setOpen}>
      <CommandForm
        action={action}
        submitLabel={submitLabel}
        className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-4"
        onSuccess={() => {
          setOpen(false);
        }}
        extraActions={
          <SheetClose render={<Button type="button" variant="outline" />}>
            Avbryt
          </SheetClose>
        }
      >
        {children}
      </CommandForm>
    </PanelSheet>
  );
};

/** A record's details, read only: for an actor who may look at a record but not change it. */
export const InspectSheet = ({
  children,
  ...frame
}: SheetFrame & { children: ReactNode }) => (
  <PanelSheet {...frame}>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
  </PanelSheet>
);
