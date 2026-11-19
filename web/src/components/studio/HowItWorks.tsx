import { BrainCircuit, ChevronDown, FolderOutput, SquareTerminal, Workflow } from "lucide-react";

/** Static explainer under the Agent Studio. Nothing here depends on a run. */
export function HowItWorks() {
  const items = [
    { Icon: Workflow, title: "Agent runtime", file: "agent.py", text: "Application code that runs the loop: send the task, receive code, run it, check the exit code, and decide whether to continue. It stops on DONE, the code run limit, an infrastructure error or Stop. After the last allowed run succeeds, the model gets one final review call to reply DONE; no code runs in that call." },
    { Icon: BrainCircuit, title: "Model", file: "planner.py", text: "Claude writes Python code, fixes it from error feedback, or replies DONE when the previous output satisfies the task. It decides what to write, not how it runs." },
    { Icon: SquareTerminal, title: "Python sandbox", file: "executor.py", text: "Runs each iter_NN.py with a timeout and returns stdout, stderr and the exit code. Missing packages may be installed and the code re-run." },
    { Icon: FolderOutput, title: "Artifacts", file: "workspace.py", text: "Files written to /workspace/output are collected after each execution and kept per iteration, so replay shows the version that existed at that step." },
  ];
  return <details className="studio-card group">
    <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold sm:px-5">
      How it works
      <span className="text-xs font-normal text-muted-foreground">one agent · one loop · four parts</span>
      <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid gap-4 border-t px-4 py-4 sm:grid-cols-2 sm:px-5">
      {items.map(({ Icon, title, file, text }) => <div key={title} className="flex gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-primary"><Icon className="size-4" /></span>
        <div>
          <p className="text-sm font-semibold">{title} <span className="font-mono text-[11px] font-normal text-muted-foreground">{file}</span></p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
        </div>
      </div>)}
      <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
        Every step on this page comes from the run’s recorded activity log. The live view shows new events in order with a short pause so fast hand-offs stay visible, then waits on the real current state.
        Model explanations are the short text the model returned with its code; the model’s internal reasoning is not shown.
      </p>
    </div>
  </details>;
}
