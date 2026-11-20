import { BrainCircuit, SquareTerminal, Workflow } from "lucide-react";
import { ACTOR_NAME, ACTOR_ROLE } from "@/lib/journey";
import type { Actor } from "@/lib/studio";
import { cn } from "@/lib/utils";

export const ACTOR_ICON: Record<Actor, typeof BrainCircuit> = { model: BrainCircuit, runtime: Workflow, sandbox: SquareTerminal };

/** The same label, icon and color for an actor everywhere: Model (violet), Runtime (graphite), Sandbox (teal). */
export function ActorChip({ actor, className }: { actor: Actor; className?: string }) {
  const Icon = ACTOR_ICON[actor];
  return <span className={cn("studio-actor-chip", `is-${actor}`, className)} title={ACTOR_ROLE[actor]}>
    <Icon className="size-3" aria-hidden />{ACTOR_NAME[actor]}
  </span>;
}

export function ActorLegend({ className }: { className?: string }) {
  return <span className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label="Who does what">
    {(["model", "runtime", "sandbox"] as const).map(a => <ActorChip key={a} actor={a} />)}
  </span>;
}
