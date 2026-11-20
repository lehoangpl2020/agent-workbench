import { useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One supporting block of the inspector that opens on demand: a full-width row (label, a quiet summary, optional
 * actions) above a hairline. Used for recorded input, reasoning and technical details so the primary evidence
 * (what was returned or executed) stays first.
 */
export function Disclosure({ label, meta, icon: Icon, actions, defaultOpen = false, open: controlled, onOpenChange, children, className }: {
  label: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  /** Shown on the right of the row (Copy...); not part of the toggle button. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const id = useId();
  const toggle = () => { setOwn(!open); onOpenChange?.(!open); };
  return <section className={cn("ins-disclosure", open && "is-open", className)}>
    <div className="flex items-center gap-2">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={toggle} className="ins-disclosure-head">
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="font-semibold text-foreground">{label}</span>
        {meta && <span className="min-w-0 truncate text-muted-foreground">{meta}</span>}
      </button>
      {actions && <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>}
    </div>
    {open && <div id={id} className="pt-3">{children}</div>}
  </section>;
}
