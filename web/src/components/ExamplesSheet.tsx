import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { CONCEPT_LABELS, EXAMPLES, OUTPUT_LABELS, type PromptExample } from "@/lib/examples";

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
        <SheetHeader className="gap-2 border-b-2 border-rule px-5 pt-5 pr-14 pb-4">
          <p className="eyebrow flex items-center gap-2"><span className="mark bg-brand" aria-hidden />{EXAMPLES.length} prompts</p>
          <SheetTitle className="text-2xl">Examples</SheetTitle>
          <SheetDescription className="leading-relaxed">
            {onUse
              ? "Each example shows one part of the agent loop. Choosing one only fills the prompt box; nothing runs until you press Run, and a model may behave differently each time."
              : "Reference only. Open New run to load an example into the prompt box."}
          </SheetDescription>
        </SheetHeader>
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto bg-card">
          {EXAMPLES.map((example, i) => (
            <li key={example.id} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-[15px] font-semibold tracking-tight">{example.title}</h3>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="tag text-foreground">
                  <span className="sr-only">Concept:</span>{CONCEPT_LABELS[example.concept]}
                </span>
                <span className="sr-only">Output:</span>
                {example.outputs.map((kind) => (
                  <span key={kind} className="tag">{OUTPUT_LABELS[kind]}</span>
                ))}
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{example.summary}</p>
              <p className="mt-2 border-l-2 border-rule pl-2.5 text-xs leading-relaxed">
                <span className="font-semibold">What to watch: </span>
                <span>{example.observe}</span>
              </p>
              <details className="group mt-2.5 text-[13px]">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs text-xs font-medium select-none hover:text-primary">
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />Prompt and how to check
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="rounded-xs bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
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
