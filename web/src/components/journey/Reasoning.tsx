import { useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import type { ReasoningKind } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";
import { NOTE } from "../styles";

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

/** The model's reasoning in one model call, exactly as the provider streamed it. Nothing here is generated. */
export function Reasoning({ state, text, firstReasoningMs, firstAnswerMs, retried, calling, provider, kind }: Props) {
  const summary = kind === "summary";
  const box = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const live = state === "live";
  const thought = firstReasoningMs != null && firstAnswerMs != null && firstAnswerMs >= firstReasoningMs
    ? firstAnswerMs - firstReasoningMs : null;

  // While it streams, keep the newest line in view unless the reader scrolled up to read
  useEffect(() => {
    if (live && follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, live, follow]);

  if (state === "waiting") {
    return <p className={NOTE}>{calling ? "Waiting for the model. Its reasoning appears here as soon as it starts."
      : "No reasoning yet at this event."}</p>;
  }
  if (state === "later") {
    return <p className={NOTE}>The model was reasoning at this point. Its text is shown from the call’s response event on,
      so nothing appears here before it arrived{text ? ` (${text.length.toLocaleString()} chars in total)` : ""}.</p>;
  }
  if (!text) {
    return <p className={NOTE}>{state === "partial" ? "The call ended before any reasoning arrived."
      : summary ? `${provider} returned no reasoning summary for this call. The model decides per call whether to reason; for a task it finds simple it often answers directly, so there is nothing to summarize.`
      : "The model streamed no reasoning in this call."}</p>;
  }

  return <figure className="space-y-2">
    <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {live ? <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
          <span className="mark animate-pulse bg-model" aria-hidden />{summary ? "Summary streaming" : "Reasoning now"}</span>
        : state === "partial" ? <span className="font-semibold text-warning">Partial: the call ended before the model finished</span>
        : <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><Brain className="size-3.5 text-model" aria-hidden />Complete</span>}
      <span className="font-mono tabular-nums">{text.length.toLocaleString()} chars</span>
      {thought != null && !live && <span className="font-mono tabular-nums" title="From the first reasoning token to the first answer token">
        {summary ? "summary streamed for" : "reasoned for"} {formatMs(thought)}</span>}
      {retried && <span>last attempt (the call was resent after invalid JSON)</span>}
      <span className="ml-auto"><CopyButton text={text} light /></span>
    </figcaption>
    <pre ref={box} tabIndex={0} aria-label={summary ? "Reasoning summary" : "Model reasoning"} aria-live="off"
      onScroll={e => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
        if (atBottom !== follow) setFollow(atBottom);
      }}
      className={cn("max-h-80 overflow-auto rounded-xs border-l-2 border-model bg-model-soft/50 px-3.5 py-2.5 font-sans text-[13px]",
        "leading-relaxed whitespace-pre-wrap text-foreground/90 [overflow-wrap:anywhere] focus-visible:outline-offset-1")}>
      {text}{live && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-model align-[-2px]" aria-hidden />}
    </pre>
    <p className="text-[11.5px] leading-relaxed text-muted-foreground">
      {summary
        ? <>A summary {provider} writes of the model’s reasoning, streamed apart from the JSON answer. {provider} never
          returns the reasoning itself, so this is a condensed account, not the reasoning, and not a verified explanation
          of how the model produced the code. It is not sent back to the model.</>
        : <>The text the model wrote in its reasoning channel, as {provider} streamed it, kept apart from the JSON answer. It
          is not sent back to the model, and it is the model’s own account, not a verified explanation of how it produced
          the code.</>}
    </p>
  </figure>;
}
