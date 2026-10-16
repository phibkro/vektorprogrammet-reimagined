import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { CommandForm } from "@/components/forms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Outcome } from "@/lib/outcome";

/**
 * A control-panel form in a dialog (Base UI: the trigger takes its element through `render`). The
 * dialog closes when the command succeeded and the page data was reloaded; a refusal stays in the
 * dialog, with its message, and nothing is saved.
 */
export const CommandDialog = ({
  trigger,
  triggerLabel,
  title,
  description,
  action,
  submitLabel,
  children,
}: {
  /** The button that opens the dialog, as an element (`<Button size="sm" />`); its label is `triggerLabel`. */
  trigger: ReactElement;
  triggerLabel: string;
  title: string;
  description?: string;
  action: (options: { data: FormData }) => Promise<Outcome<string>>;
  submitLabel: string;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger}>{triggerLabel}</DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <CommandForm
          action={action}
          submitLabel={submitLabel}
          className="grid gap-4"
          onSuccess={() => {
            setOpen(false);
          }}
          extraActions={
            <DialogClose render={<Button type="button" variant="outline" />}>
              Avbryt
            </DialogClose>
          }
        >
          {children}
        </CommandForm>
      </DialogContent>
    </Dialog>
  );
};
