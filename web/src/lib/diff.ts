// A line diff between two recorded code files (longest common subsequence). It shows WHAT changed between two
// files the model returned; it says nothing about why they changed.

export type DiffKind = "same" | "add" | "del";
export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old / new file (absent for the side the line is not in). */
  a?: number;
  b?: number;
}

// Above this many cells the O(n·m) table is not worth it in a browser; the caller shows both files instead.
const MAX_CELLS = 4_000_000;

function lines(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return t === "" ? [] : t.split("\n");
}

/** Line-by-line difference from `before` to `after`, or null when the files are too large to compare here. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = lines(before);
  const b = lines(after);
  // Common head and tail first: most corrections touch a few lines in the middle
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) return null;

  // lcs[i][j] = length of the LCS of am[i:] and bm[j:]
  const w = bm.length + 1;
  const lcs = new Uint32Array((am.length + 1) * w);
  for (let i = am.length - 1; i >= 0; i--) {
    for (let j = bm.length - 1; j >= 0; j--) {
      lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: "same", text: a[k], a: k + 1, b: k + 1 });
  let i = 0;
  let j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      out.push({ kind: "same", text: am[i], a: head + i + 1, b: head + j + 1 });
      i++; j++;
    } else if (i < am.length && (j >= bm.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      // Removals before additions, as in a unified diff
      out.push({ kind: "del", text: am[i], a: head + i + 1 });
      i++;
    } else {
      out.push({ kind: "add", text: bm[j], b: head + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < tail; k++) {
    out.push({ kind: "same", text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
  }
  return out;
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.kind === "add") added++;
    else if (d.kind === "del") removed++;
  }
  return { added, removed };
}

export type DiffRow = DiffLine | { kind: "gap"; hidden: number };

/** Unchanged runs longer than 2·context+1 lines fold into one "gap" row, so the changes stay in view. */
export function foldDiff(diff: DiffLine[], context = 3): DiffRow[] {
  const near = diff.map(() => false);
  diff.forEach((d, k) => {
    if (d.kind === "same") return;
    for (let x = Math.max(0, k - context); x <= Math.min(diff.length - 1, k + context); x++) near[x] = true;
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  diff.forEach((d, k) => {
    if (near[k]) {
      if (hidden) { out.push({ kind: "gap", hidden }); hidden = 0; }
      out.push(d);
    } else hidden++;
  });
  if (hidden) out.push({ kind: "gap", hidden });
  return out;
}
