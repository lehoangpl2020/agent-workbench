import { ArrowRight } from "lucide-react";
import type { AccountRow } from "@/lib/journey";
import { cn } from "@/lib/utils";

const TONE = { ok: "text-success", bad: "text-destructive", warn: "text-warning", muted: "text-muted-foreground" } as const;

/** "In this run": who acted, the input, what came back and what the record shows next, as a short definition list. */
export function StepAccount({ rows, onGoto }: { rows: AccountRow[]; onGoto: (key: string) => void }) {
  return <section aria-label="What happened in this step" className="ins-account">
    <h4 className="ins-h">In this run</h4>
    <dl>
      {rows.map(r => <div key={r.key} className="ins-account-row">
        <dt>{r.label}</dt>
        <dd className="min-w-0">
          <p className={cn("font-medium", r.tone && TONE[r.tone], r.key === "next" && "font-normal")}>{r.text}</p>
          {r.detail && <p title={r.mono ? undefined : r.detail}
            className={cn("mt-0.5 text-[13.5px] text-muted-foreground", r.mono ? "font-mono text-[13px] text-destructive" : "line-clamp-3")}>{r.detail}</p>}
          {r.goto && <button type="button" className="text-link mt-1 inline-flex items-center gap-1 text-[13px]" onClick={() => onGoto(r.goto!.key)}>
            Go to {r.goto.label}<ArrowRight className="size-3.5" aria-hidden /></button>}
        </dd>
      </div>)}
    </dl>
  </section>;
}
