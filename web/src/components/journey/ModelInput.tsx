import { useState } from "react";
import { ChevronRight, FileQuestion } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { describeMessage, recordedRequests, type JourneySection } from "@/lib/journey";
import { providerLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";

interface Props {
  run: RunDetail;
  section: JourneySection;
  /** Selected step: a call that starts later has not happened yet at this point. */
  upto: number;
  onSelect: (index: number) => void;
}

/** "What did the model receive?": the input of one model call, exactly as recorded, or an honest empty state. */
export function ModelInput({ run, section, upto, onSelect }: Props) {
  const all = recordedRequests(section);
  const calls = section.steps.filter(s => s.beat === "calling");
  const reached = all.filter(r => r.step.index <= upto);
  const [attempt, setAttempt] = useState<number | null>(null);
  const running = run.status === "running" || run.status === "pending";

  if (!reached.length) {
    const later = all.find(r => r.step.index > upto);
    if (later) return <Empty>
      The request is recorded when the call starts.{" "}
      <button type="button" className="font-medium text-primary hover:underline" onClick={() => onSelect(later.step.index)}>
        Go to the call event</button>
    </Empty>;
    if (running && !calls.length) return <Empty>The runtime is preparing the request. It is recorded when the call starts.</Empty>;
    return <div className="space-y-2">
      <Empty><FileQuestion className="mr-1.5 inline size-3.5 align-[-2px]" />
        <strong className="font-semibold text-foreground">Not recorded.</strong> This run was stored before model inputs were saved, so the
        exact system instructions and messages are unknown.</Empty>
      <p className="text-xs text-muted-foreground">Known from the run record (not the recorded request): the task was</p>
      <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[13px] break-words whitespace-pre-wrap">{run.prompt}</p>
      {section.number != null && section.number > 1 && <p className="text-xs text-muted-foreground">
        Earlier code and execution feedback were also part of this call, but their exact text was not stored.</p>}
    </div>;
  }

  const shown = reached[Math.min(attempt ?? reached.length - 1, reached.length - 1)];
  const last = shown.messages.length - 1;
  return <div className="space-y-2.5">
    <p className="text-[11.5px] leading-relaxed text-muted-foreground">
      Recorded when the call started: the system instructions and {shown.messages.length} message{shown.messages.length === 1 ? "" : "s"} the
      runtime passed to the {providerLabel(run)} adapter, with secrets masked. The adapter may reformat them for its API.
      Images or files are only included if they appear in this text.
    </p>
    {reached.length > 1 && <div className="studio-segment" role="group" aria-label="Call attempt">
      {reached.map((r, i) => <button key={r.step.key} type="button" aria-pressed={r === shown} onClick={() => setAttempt(i)}>
        {i === 0 ? "First attempt" : "Format retry"}</button>)}
    </div>}
    <Message title="System instructions" hint="Same for every call in this run" text={shown.system} tone="system" />
    {shown.messages.map((m, i) => <Message key={`${shown.step.key}-${i}`} title={`${i + 1}. ${m.role}`} hint={describeMessage(m, i)}
      text={m.content} tone={m.role === "assistant" ? "assistant" : "user"} defaultOpen={i === last} />)}
  </div>;
}

function Message({ title, hint, text, tone, defaultOpen = false }: {
  title: string; hint: string; text: string; tone: "system" | "user" | "assistant"; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className={cn("overflow-hidden rounded-lg border", tone === "assistant" ? "border-[var(--model)]/25" : "")}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50">
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      <span className={cn("rounded px-1.5 font-mono text-[10.5px] font-semibold leading-[18px]",
        tone === "system" ? "bg-muted text-muted-foreground" : tone === "assistant" ? "bg-[var(--model-soft)] text-[var(--model)]" : "bg-accent text-accent-foreground")}>
        {title}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hint}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{text.length.toLocaleString()} chars</span>
    </button>
    {open && <div className="relative border-t bg-code">
      <div className="absolute top-1.5 right-1.5"><CopyButton text={text} /></div>
      <pre className="max-h-80 overflow-auto px-3 py-2.5 pr-20 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-code-foreground">
        {text || "(empty)"}</pre>
    </div>}
  </div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px] leading-relaxed text-muted-foreground">{children}</p>;
}

