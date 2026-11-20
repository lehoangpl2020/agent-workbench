import { describe, expect, it } from "vitest";
import { diffStats, foldDiff, lineDiff } from "./diff";

describe("lineDiff", () => {
  it("marks added and removed lines with their line numbers", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")!;
    expect(d.map(l => `${l.kind}:${l.text}`)).toEqual(["same:a", "del:b", "add:B", "same:c", "add:d"]);
    expect(d.find(l => l.kind === "add" && l.text === "d")).toMatchObject({ b: 4 });
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });

  it("handles empty and identical files", () => {
    expect(diffStats(lineDiff("", "x\ny")!)).toEqual({ added: 2, removed: 0 });
    expect(diffStats(lineDiff("x\r\ny", "x\ny")!)).toEqual({ added: 0, removed: 0 });
  });

  it("folds long unchanged runs around the changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "changed");
    const rows = foldDiff(lineDiff(before, after)!, 2);
    expect(rows[0]).toEqual({ kind: "gap", hidden: 8 });
    expect(rows.filter(r => r.kind !== "gap")).toHaveLength(6);
    expect(rows.at(-1)).toEqual({ kind: "gap", hidden: 7 });
  });
});
