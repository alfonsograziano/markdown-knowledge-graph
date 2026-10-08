"""Layer 1: exact edges. Links between files and frontmatter references go straight into
Neo4j. No LLM, no AWS, no cost.

  LINKS_TO   a [[wiki link]] or a [markdown](link.md) in the body
  REF        a frontmatter field whose value names another file, for example `project: apollo`
"""

import re
from collections import Counter
from pathlib import Path
from urllib.parse import unquote

from neo4j import GraphDatabase

from .config import SOURCE_ROOT, Settings
from .scope import Doc, Scope, docs_in_scope, read_doc

WIKI_LINK = re.compile(r"\[\[([^\]]+)\]\]")
MD_LINK = re.compile(r"\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")
SKIP_DIRS = {".git", "node_modules", ".next", ".venv", ".obsidian"}
# Frontmatter fields that never point at another file.
NOT_REFS = {"title", "status", "created", "updated", "date", "tags", "type", "aliases"}


def all_md_files() -> list[str]:
    files = []
    for f in SOURCE_ROOT.rglob("*.md"):
        rel = f.relative_to(SOURCE_ROOT)
        if not SKIP_DIRS.intersection(rel.parts):
            files.append(rel.as_posix())
    return files


class Resolver:
    """Turns a link target (a path, a file name, or a file name without .md) into a path."""

    def __init__(self) -> None:
        self.files = set(all_md_files())
        self.by_stem: dict[str, list[str]] = {}
        for f in self.files:
            self.by_stem.setdefault(Path(f).name[:-3], []).append(f)

    def name(self, raw: str) -> str | None:
        target = raw.split("|")[0].split("#")[0].strip().strip("/")
        if not target:
            return None
        if target.endswith(".md"):
            target = target[:-3]
        if f"{target}.md" in self.files:
            return f"{target}.md"
        matches = self.by_stem.get(Path(target).name, [])
        return matches[0] if len(matches) == 1 else None

    def markdown(self, raw: str, from_path: str) -> str | None:
        target = unquote(raw.strip("<>")).split("#")[0]
        if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or not target.endswith(".md"):
            return None
        bases = [SOURCE_ROOT] if target.startswith("/") else [(SOURCE_ROOT / from_path).parent, SOURCE_ROOT]
        for base in bases:
            resolved = (base / target.lstrip("/")).resolve()
            try:
                rel = resolved.relative_to(SOURCE_ROOT).as_posix()
            except ValueError:
                continue
            if rel in self.files:
                return rel
        return None


def node_props(doc: Doc, in_scope: bool) -> dict:
    return {
        "key": doc.path, "path": doc.path, "type": doc.doc_type or "file",
        "title": doc.title, "status": str(doc.meta.get("status", "")), "in_scope": in_scope,
    }


def build(scope: Scope) -> tuple[dict[str, dict], list[tuple[str, str, str, dict]]]:
    resolver = Resolver()
    docs = docs_in_scope(scope)

    nodes: dict[str, dict] = {}
    edges: list[tuple[str, str, str, dict]] = []

    for doc in docs:
        nodes[doc.path] = node_props(doc, True)

    def ensure(path: str) -> None:
        # A linked file outside the scope gets a node, but its text is never indexed.
        if path not in nodes:
            nodes[path] = node_props(read_doc(path), False)

    for doc in docs:
        for field, value in doc.meta.items():
            if field in NOT_REFS:
                continue
            for item in value if isinstance(value, list) else [value]:
                target = resolver.name(item) if isinstance(item, str) else None
                if target and target != doc.path:
                    ensure(target)
                    edges.append((doc.path, "REF", target, {"field": field}))

        targets = [resolver.name(m) for m in WIKI_LINK.findall(doc.body)]
        targets += [resolver.markdown(m, doc.path) for m in MD_LINK.findall(doc.body)]
        for target in {t for t in targets if t and t != doc.path}:
            ensure(target)
            edges.append((doc.path, "LINKS_TO", target, {}))

    return nodes, edges


def summary(nodes: dict[str, dict], edges: list) -> str:
    in_scope = sum(1 for n in nodes.values() if n["in_scope"])
    kinds = Counter(rel for _, rel, _, _ in edges)
    lines = [f"{len(nodes)} nodes ({in_scope} in scope, {len(nodes) - in_scope} linked from outside it)"]
    lines.append("edges: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())) if edges else "edges: none")
    for src, rel, dst, props in edges[:15]:
        extra = f" ({props['field']})" if props.get("field") else ""
        lines.append(f"  {src} -[{rel}{extra}]-> {dst}")
    if len(edges) > 15:
        lines.append(f"  ... and {len(edges) - 15} more")
    return "\n".join(lines)


BRIDGE = """
MATCH (f:Document) WHERE f.path IS NOT NULL
MATCH (e:Episodic) WHERE e.name STARTS WITH f.path + '#'
MERGE (f)-[:HAS_EPISODE]->(e)
"""


def _driver(settings: Settings):
    return GraphDatabase.driver(
        settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password), notifications_min_severity="OFF"
    )


def bridge(settings: Settings) -> None:
    """Connect each document node to the Graphiti episodes that were cut from it."""
    with _driver(settings) as driver:
        driver.execute_query(BRIDGE)


def write(settings: Settings, nodes: dict[str, dict], edges: list) -> None:
    """Layer 1 is current state only: wipe it and write it again."""
    with _driver(settings) as driver:
        driver.execute_query("CREATE CONSTRAINT document_key IF NOT EXISTS FOR (n:Document) REQUIRE n.key IS UNIQUE")
        driver.execute_query("MATCH (n:Document) DETACH DELETE n")
        driver.execute_query(
            "UNWIND $rows AS row MERGE (n:Document {key: row.key}) SET n += row",
            rows=list(nodes.values()),
        )
        for rel in ("REF", "LINKS_TO"):  # fixed names, so safe to put in the query
            rows = [{"src": s, "dst": d, "props": p} for s, r, d, p in edges if r == rel]
            driver.execute_query(
                f"UNWIND $rows AS row MATCH (a:Document {{key: row.src}}), (b:Document {{key: row.dst}}) "
                f"MERGE (a)-[e:{rel}]->(b) SET e += row.props",
                rows=rows,
            )
        driver.execute_query(BRIDGE)
