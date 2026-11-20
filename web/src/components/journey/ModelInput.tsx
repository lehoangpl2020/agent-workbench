import { useState } from "react";
import { ChevronRight, FileQuestion, MessagesSquare } from "lucide-react";
import type { RunDetail } from "@/lib/api";
import { describeMessage, recordedRequests, type JourneySection } from "@/lib/journey";
import { providerLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "../CodeView";
import { NOTE } from "../styles";
import { Disclosure } from "./Disclosure";

interface Props {
  run: RunDetail;
  section: JourneySection;
  /** Selected step: a call that starts later has not happened yet at this point. */
  upto: number;
  onSelect: (index: number) => void;
}

/**
 * "What did the model receive?": the input of one model call, exactly as recorded, or an honest empty state.
 * The newest message (what changed since the last call: the task, an error or an output) is shown first; the
 * system instructions and the earlier conversation are one click away.
 */
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
      <button type="button" className="text-link" onClick={() => onSelect(later.step.index)}>
        Go to the call event</button>
    </Empty>;
    if (running && !calls.length) return <Empty>The runtime is preparing the request. It is recorded when the call starts.</Empty>;
    return <div className="space-y-2">
      <Empty><FileQuestion className="mr-1.5 inline size-3.5 align-[-2px]" />
        <strong className="font-semibold text-foreground">Not recorded.</strong> This run was stored before model inputs were saved, so the
        exact system instructions and messages are unknown.</Empty>
      <p className="text-[13px] text-muted-foreground">Known from the run record (not the recorded request): the task was</p>
      <p className="rounded-xs border-l-2 border-rule bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap">{run.prompt}</p>
      {section.number != null && section.number > 1 && <p className="text-[13px] text-muted-foreground">
        Earlier code and execution feedback were also part of this call, but their exact text was not stored.</p>}
    </div>;
  }

  const shown = reached[Math.min(attempt ?? reached.length - 1, reached.length - 1)];
  const last = shown.messages.length - 1;
  const newest = shown.messages[last];
  return <div className="space-y-3">
    {reached.length > 1 && <div className="studio-segment" role="group" aria-label="Call attempt">
      {reached.map((r, i) => <button key={r.step.key} type="button" aria-pressed={r === shown} onClick={() => setAttempt(i)}>
        {i === 0 ? "First attempt" : "Format retry"}</button>)}
    </div>}
    {newest && <NewestMessage key={shown.step.key} index={last} role={newest.role} hint={describeMessage(newest, last)} text={newest.content} />}
    <Disclosure icon={MessagesSquare} label="Full recorded input"
      meta={`system instructions + ${shown.messages.length} message${shown.messages.length === 1 ? "" : "s"}`}>
      <div className="space-y-2">
        <p className="max-w-[78ch] text-[13px] leading-relaxed text-muted-foreground">
          Recorded when the call started: what the runtime passed to the {providerLabel(run)} adapter, with secrets masked. The adapter
          may reformat it for its API. Images or files are only included if they appear in this text.
        </p>
        <Message title="System" hint="System instructions · the same for every call in this run" text={shown.system} tone="system" />
        {shown.messages.map((m, i) => <Message key={`${shown.step.key}-${i}`} title={`${i + 1}. ${m.role}`} hint={describeMessage(m, i)}
          text={m.content} tone={m.role === "assistant" ? "assistant" : "user"} />)}
      </div>
    </Disclosure>
  </div>;
}

const CLAMP_LINES = 12;

/** The last message of the request, which carries what is new in this call. Long text is shortened until asked. */
function NewestMessage({ index, role, hint, text }: { index: number; role: string; hint: string; text: string }) {
  const lines = text.split("\n");
  // A few lines over the limit are not worth a click: clamp only when it saves real space
  const long = lines.length > CLAMP_LINES + 4 || text.length > 1800;
  const [all, setAll] = useState(false);
  const shown = long && !all ? `${lines.slice(0, CLAMP_LINES).join("\n").slice(0, 1400)}…` : text;
  const failure = hint === "Execution feedback: failure" || hint === "Execution feedback: timeout";
  return <figure className="overflow-hidden rounded-md border border-code-border bg-code">
    <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-code-border px-3 py-1.5">
      <span className="font-mono text-xs text-code-muted">{index + 1}. {role}</span>
      <span className={cn("min-w-0 flex-1 truncate text-xs font-medium", failure ? "text-[#f3a3b5]" : "text-code-foreground")}>{hint}</span>
      <span className="font-mono text-[11px] text-code-muted tabular-nums">{text.length.toLocaleString()} chars</span>
      <CopyButton text={text} />
    </figcaption>
    <pre className="px-3.5 py-3 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-code-foreground">{shown || "(empty)"}</pre>
    {long && <button type="button" onClick={() => setAll(v => !v)} aria-expanded={all}
      className="w-full border-t border-code-border px-3 py-1.5 text-left text-xs font-medium text-code-foreground/90 hover:bg-white/5 focus-visible:outline-offset-[-2px]">
      {all ? "Show less" : `Show all ${lines.length.toLocaleString()} lines`}</button>}
  </figure>;
}

function Message({ title, hint, text, tone }: { title: string; hint: string; text: string; tone: "system" | "user" | "assistant" }) {
  const [open, setOpen] = useState(false);
  return <div className={cn("overflow-hidden rounded-md border bg-card", tone === "assistant" && "border-l-2 border-l-model")}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-offset-[-2px]">
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      <span className={cn("rounded-xs border px-1.5 font-mono text-[11px] font-semibold leading-[18px]",
        tone === "system" ? "border-border bg-muted text-foreground" : tone === "assistant" ? "border-transparent bg-model-soft text-model" : "border-rule bg-card text-foreground")}>
        {title}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{hint}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{text.length.toLocaleString()} chars</span>
    </button>
    {/* Opened text is shown in full: no nested scroll area inside the inspector */}
    {open && <div className="relative border-t bg-code">
      <div className="absolute top-1.5 right-1.5"><CopyButton text={text} /></div>
      <pre className="px-3 py-2.5 pr-20 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-code-foreground">
        {text || "(empty)"}</pre>
    </div>}
  </div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className={NOTE}>{children}</p>;
}
