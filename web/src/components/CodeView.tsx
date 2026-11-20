import { useEffect, useRef, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label = "Copy", light = false }: { text: string; label?: string; light?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Fallback when the clipboard API is blocked (http that is not localhost…)
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
        light ? "border-input bg-card text-foreground hover:border-foreground" : "border-white/15 bg-transparent text-code-foreground/90 hover:border-white/40 hover:bg-white/5")}
    >
      {copied ? <Check className={cn("size-3.5", light ? "text-success" : "text-emerald-400")} /> : <Copy className="size-3.5" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

/** Python code with syntax highlighting, dark background, line numbers and a Copy button. */
export function CodeView({
  code,
  language = "python",
  title,
  follow = false,
}: {
  code: string;
  language?: string;
  title?: string;
  /** Scroll to the last line automatically when the code changes (used while streaming) */
  follow?: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [code, follow]);
  return (
    <div className="overflow-hidden rounded-md border border-code-border bg-code">
      <div className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs text-code-muted">{title ?? `${language}`}</span>
        <CopyButton text={code} />
      </div>
      <Highlight code={code.replace(/\n$/, "")} language={language} theme={themes.vsDark}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre ref={preRef} className="max-h-[560px] overflow-auto py-3 font-mono text-[13px] leading-relaxed">
            {tokens.map((line, i) => {
              const { className, ...rest } = getLineProps({ line });
              return (
                <div key={i} className={cn(className, "table-row")} {...rest}>
                  <span className="table-cell select-none pr-4 pl-3 text-right text-code-muted/70">{i + 1}</span>
                  <span className="table-cell pr-4">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/** Monospace text block with a dark background (stdout/stderr). */
export function TerminalBlock({
  label,
  text,
  tone = "default",
  empty = "(empty)",
}: {
  label: string;
  text: string;
  tone?: "default" | "error";
  empty?: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-code-border bg-code">
      <div className="flex items-center justify-between gap-2 border-b border-code-border px-3 py-1.5">
        <span className={cn("min-w-0 truncate font-mono text-xs", tone === "error" ? "text-[#f3a3b5]" : "text-code-muted")}>{label}</span>
        {text && <CopyButton text={text} />}
      </div>
      <pre
        className={cn(
          "max-h-[420px] overflow-auto px-3 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words",
          tone === "error" ? "text-[#f6c3cf]" : "text-code-foreground",
          !text && "text-code-muted italic",
        )}
      >
        {text || empty}
      </pre>
    </div>
  );
}
