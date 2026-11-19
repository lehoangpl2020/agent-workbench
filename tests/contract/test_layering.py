"""
The dependency rule of the backend package (docs/project-structure.md): a module may import from its own
package or from a LOWER layer, never from a higher one, and never from a sibling on the same layer.

Read from the source with `ast`, so a forbidden import fails here before it becomes a hidden coupling.
To move a package to another layer, change LAYERS and the diagram in docs/project-structure.md together.
"""

import ast
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[2] / "src" / "agent_workbench"

# Lower number = lower layer. Packages on the same layer are independent of each other.
LAYERS = {
    "domain": 0, "observability": 0,             # pure data and the event contract; log entries + redaction
    "storage": 1,                                # SQLite history, per-run directory
    "llm": 2, "execution": 2, "tools": 2,        # adapters to the outside world
    "core": 3,                                   # the agent loop
    "runs": 4,                                   # application services
    "config": 5,                                 # Settings: reads the environment, knows every feature's settings
    "api": 6,                                    # delivery + composition root (api/bootstrap.py)
    "__main__": 7,
}


def layer_of(module: str) -> str:
    """'agent_workbench.core.planner' -> 'core'; 'agent_workbench.config' -> 'config'."""
    return module.split(".")[1]


def internal_imports(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names = [node.module]
        elif isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        else:
            continue
        found += [(node.lineno, n) for n in names if n.startswith("agent_workbench.")]
    return found


def modules():
    for path in sorted(PKG_ROOT.rglob("*.py")):
        rel = path.relative_to(PKG_ROOT).with_suffix("")
        if rel.parts == ("__init__",):
            continue
        yield path, rel.parts[0]


def test_every_package_has_a_layer():
    assert {layer for _, layer in modules()} <= set(LAYERS), "add the new package to LAYERS (and the docs diagram)"


def test_imports_only_go_down_the_layers():
    violations = []
    for path, own in modules():
        for line, target in internal_imports(path):
            other = layer_of(target)
            if other == own:
                continue
            if LAYERS[other] >= LAYERS[own]:
                kind = "a sibling on the same layer" if LAYERS[other] == LAYERS[own] else "a HIGHER layer"
                violations.append(f"{path.relative_to(PKG_ROOT)}:{line} imports {target} ({kind})")
    assert not violations, "Dependency rule broken:\n" + "\n".join(violations)


def test_relative_imports_are_not_used():
    """Absolute imports keep every module's dependencies greppable and visible to the check above."""
    offenders = [f"{p.relative_to(PKG_ROOT)}:{n.lineno}" for p, _ in modules()
                 for n in ast.walk(ast.parse(p.read_text(encoding="utf-8")))
                 if isinstance(n, ast.ImportFrom) and n.level > 0]
    assert not offenders, offenders


def test_the_rule_catches_a_violation(tmp_path):
    """The checker itself works: an executor importing a tool (the coupling removed in this refactor) is reported."""
    bad = tmp_path / "bad.py"
    bad.write_text("from agent_workbench.tools.image import tool_url\n", encoding="utf-8")
    [(_, target)] = internal_imports(bad)
    assert LAYERS[layer_of(target)] >= LAYERS["execution"]
