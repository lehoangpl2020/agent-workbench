import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import type { ReasoningKind } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";
import { Disclosure } from "./Disclosure";

/**
 * Where the selected point stands in this model call's reasoning:
 *   live     the call is running and the model is reasoning now (text grows)
 *   complete the call ended; the text is everything the model streamed
 *   partial  the call ended without a response (Stop or an error); the text is what arrived before that
 *   later    the model reasoned in this call, but the selected event comes before its response (replay/explore)
 *   waiting  no reasoning yet at this point
 */
export type ReasoningState = "live" | "complete" | "partial" | "later" | "waiting";

interface Props {
  state: ReasoningState;
  text: string;
  /** ms from the call's start to the first reasoning token / the first answer token, from the recorded log */
  firstReasoningMs?: number | null;
  firstAnswerMs?: number | null;
  /** The call was resent after invalid JSON: the stored text is the last attempt's */
  retried?: boolean;
  /** Live: the call is still waiting for its first token */
  calling?: boolean;
  /** Display name of the provider that streamed the text */
  provider: string;
  /** The model's own reasoning text, or the provider's summary of it */
  kind: ReasoningKind;
}

/**
 * The model's reasoning in one model call, exactly as the provider streamed it. Nothing here is generated.
 * It is open while it streams live; for a finished call it is a closed reading view, so it never pushes the
 * returned code out of sight.
 */
export function Reasoning({ state, text, firstReasoningMs, firstAnswerMs, retried, calling, provider, kind }: Props) {
  const summary = kind === "summary";
  const box = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const live = state === "live";
  const [open, setOpen] = useState(live);
  useEffect(() => { if (live) setOpen(true); }, [live]);
  const thought = firstReasoningMs != null && firstAnswerMs != null && firstAnswerMs >= firstReasoningMs
    ? firstAnswerMs - firstReasoningMs : null;

  // While it streams, keep the newest line in view unless the reader scrolled up to read
  useEffect(() => {
    if (live && follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, live, follow]);

  const label = summary ? "Reasoning summary" : "Reasoning";
  const source = summary ? `written by ${provider}` : `reasoning channel · ${provider}`;

  let note: string | null = null;
  if (state === "waiting") note = calling ? "appears here as soon as the model starts reasoning" : "none yet at this event";
  else if (state === "later") note = "recorded with the call’s response, after this event";
  else if (!text) note = state === "partial" ? "the call ended before any reasoning arrived"
    : summary ? `${provider} returned no summary for this call` : "the model streamed no reasoning in this call";
  if (note) {
    return <section className="ins-disclosure">
      <p className="ins-disclosure-head cursor-default">
        <Brain className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-semibold">{label}</span>
        <span className="min-w-0 text-muted-foreground">{note}</span>
      </p>
      {summary && !text && state === "complete" && <p className="mt-1 pl-6 text-[13px] leading-relaxed text-muted-foreground">
        The model decides per call whether to reason; for a task it finds simple it often answers directly, so there is nothing to summarize.</p>}
    </section>;
  }

  const meta = <>
    {live ? <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><span className="mark animate-pulse bg-model" aria-hidden />streaming now</span>
      : state === "partial" ? <span className="font-medium text-warning">partial</span> : source}
    <span className="font-mono text-[12px] tabular-nums"> · {text.length.toLocaleString()} chars</span>
    {thought != null && !live && <span className="font-mono text-[12px] tabular-nums" title="From the first reasoning token to the first answer token">
      {" "}· {formatMs(thought)}</span>}
  </>;

  return <Disclosure label={label} meta={meta} icon={Brain} open={open} onOpenChange={setOpen}
    actions={<CopyButton text={text} light />}>
    <div className="space-y-2">
      {state === "partial" && <p className="text-[13px] text-warning">Partial: the call ended before the model finished.</p>}
      {retried && <p className="text-[13px] text-muted-foreground">From the last attempt (the call was resent after invalid JSON).</p>}
      <pre ref={box} tabIndex={0} aria-label={summary ? "Reasoning summary" : "Model reasoning"} aria-live="off"
        onScroll={live ? e => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
          if (atBottom !== follow) setFollow(atBottom);
        } : undefined}
        className={cn("ins-reasoning", live && "max-h-80 overflow-auto")}>
        {text}{live && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-model align-[-2px]" aria-hidden />}
      </pre>
      <p className="max-w-[78ch] text-[13px] leading-relaxed text-muted-foreground">
        {summary
          ? <>A summary {provider} writes of the model’s reasoning; {provider} does not return the reasoning itself. </>
          : <>The text the model wrote in its reasoning channel, kept apart from its JSON answer. </>}
        It is the model’s own account, not a verified explanation of the code, and it is not sent back to the model.
      </p>
    </div>
  </Disclosure>;
}
