"""
Checks that relative links in Markdown files point to files that exist, and that `#anchor` parts match a
heading in the target file (GitHub-style slugs). External links (http, mailto) are skipped.

Usage, from the repository root:

    python .claude/skills/verify-change/scripts/check_links.py README.md docs/api.md

Exit code 1 if any link is broken.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^(```|~~~)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")


def slug(text: str) -> str:
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(path: Path) -> set[str]:
    seen: dict[str, int] = {}
    out: set[str] = set()
    in_fence = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        m = None if in_fence else HEADING.match(line)
        if m:
            s = slug(m.group(1))
            n = seen.get(s, 0)
            out.add(s if n == 0 else f"{s}-{n}")
            seen[s] = n + 1
    return out


def links(path: Path):
    in_fence = False
    for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in LINK.finditer(line):
            yield no, m.group(1)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    broken, checked = [], 0
    for name in argv:
        src = Path(name)
        if not src.exists() or src.suffix.lower() != ".md":
            continue
        for no, target in links(src):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                continue
            checked += 1
            file_part, _, anchor = target.partition("#")
            dest = (src.parent / file_part).resolve() if file_part else src.resolve()
            if not dest.exists():
                broken.append(f"{src}:{no}: {target} -> missing file")
            elif anchor and dest.is_file() and dest.suffix.lower() == ".md" and anchor.lower() not in anchors(dest):
                broken.append(f"{src}:{no}: {target} -> no heading '#{anchor}' in {dest.name}")
    for b in broken:
        print(b)
    print(f"{checked} relative links checked, {len(broken)} broken")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
