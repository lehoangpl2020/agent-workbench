import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { EXAMPLES, OUTPUT_LABELS, type PromptExample } from "@/lib/examples";

interface Props {
  /** The element that opens the sheet. It must be a single element that accepts a ref, such as a button. */
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** With a handler every example gets a "Use this prompt" button. Without one the sheet is a read-only reference. */
  onUse?: (example: PromptExample) => void;
  /** Call event.preventDefault() to take over focus when the sheet closes; otherwise it returns to the trigger. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function ExamplesSheet({ trigger, open, onOpenChange, onUse, onCloseAutoFocus }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* A real trigger is what lets Radix return focus to the opener on close */}
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Examples</SheetTitle>
          <SheetDescription>
            {onUse
              ? "Choose one to fill the prompt box. You can edit it before pressing Run."
              : "Reference only. Open New run to load an example into the prompt box."}
          </SheetDescription>
        </SheetHeader>
        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {EXAMPLES.map((example) => (
            <li key={example.id} className="rounded-lg border bg-card p-3.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-semibold">{example.title}</h3>
                <span className="flex gap-1">
                  <span className="sr-only">Output:</span>
                  {example.outputs.map((kind) => (
                    <span
                      key={kind}
                      className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground"
                    >
                      {OUTPUT_LABELS[kind]}
                    </span>
                  ))}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{example.summary}</p>
              <details className="mt-2 text-[13px]">
                <summary className="cursor-pointer rounded-sm text-xs font-medium text-primary outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  Prompt and how to check
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="rounded-md bg-muted/60 px-2.5 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
                    {example.prompt}
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-foreground/80">
                    {example.check.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-muted-foreground">
                    Guidance for a person reading the result. It is not an automated check.
                  </p>
                </div>
              </details>
              {onUse && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  aria-label={`Use this prompt: ${example.title}`}
                  onClick={() => onUse(example)}
                >
                  Use this prompt
                </Button>
              )}
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
