import { useEffect, useRef, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs font-medium text-code-foreground/90 transition hover:bg-white/10"
    >
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
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
    <div className="overflow-hidden rounded-lg border border-code-border bg-code">
      <div className="flex items-center justify-between border-b border-code-border px-3 py-2">
        <span className="font-mono text-xs text-code-muted">{title ?? `${language}`}</span>
        <CopyButton text={code} />
      </div>
      <Highlight code={code.replace(/\n$/, "")} language={language} theme={themes.vsDark}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre ref={preRef} className="max-h-[560px] overflow-auto py-3 font-mono text-[13px] leading-relaxed">
            {tokens.map((line, i) => {
              const { className, ...rest } = getLineProps({ line });
              return (
                <div key={i} className={cn(className, "table-row")} {...rest}>
                  <span className="table-cell select-none pr-4 pl-3 text-right text-code-muted/60">{i + 1}</span>
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
    <div className="overflow-hidden rounded-lg border border-code-border bg-code">
      <div className="flex items-center justify-between border-b border-code-border px-3 py-2">
        <span className={cn("font-mono text-xs", tone === "error" ? "text-red-300" : "text-code-muted")}>{label}</span>
        {text && <CopyButton text={text} />}
      </div>
      <pre
        className={cn(
          "max-h-[420px] overflow-auto px-3 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words",
          tone === "error" ? "text-red-200" : "text-code-foreground",
          !text && "text-code-muted italic",
        )}
      >
        {text || empty}
      </pre>
    </div>
  );
}
