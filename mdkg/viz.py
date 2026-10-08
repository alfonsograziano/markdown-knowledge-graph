"""Writes data/graph.html: both layers in one interactive graph viewer. Local only.

The page is one offline file. The viewer code (static/viewer.html, static/viewer.js) and three
libraries are inlined, so opening it makes no network request:

  graphology 0.26.0          static/graphology-0.26.0.umd.min.js   graph model
  graphology-library 0.8.0   static/graphology-library-0.8.0.min.js ForceAtlas2, Louvain, metrics
  sigma 3.0.3                static/sigma-3.0.3.min.js             WebGL renderer

All three are the files published on npm, with the sourceMappingURL comment removed.
"""

import json
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from neo4j import GraphDatabase

from .config import SOURCE_ROOT, DATA_DIR, Settings

STATIC = Path(__file__).parent / "static"
LIBS = ["graphology-0.26.0.umd.min.js", "graphology-library-0.8.0.min.js", "sigma-3.0.3.min.js"]

QUERIES = {
    "files": "MATCH (n:Document) RETURN n.key AS key, n.path AS path, n.title AS title, n.type AS type, "
             "n.status AS status, n.in_scope AS in_scope",
    "layer1": "MATCH (a:Document)-[r:REF|LINKS_TO]->(b:Document) "
              "RETURN a.key AS s, b.key AS t, type(r) AS rel, r.field AS field",
    "entities": "MATCH (n:Entity) RETURN n.uuid AS id, n.name AS name, n.summary AS summary, n.labels AS labels",
    # Every fact, also the ones that are no longer true: the viewer can show them on request.
    "facts": "MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) RETURN a.uuid AS s, b.uuid AS t, r.name AS rel, "
             "r.fact AS fact, r.valid_at AS valid_at, r.invalid_at AS invalid_at, r.episodes AS episodes",
    "episodes": "MATCH (e:Episodic) RETURN e.uuid AS id, e.name AS name",
    # An episode is named <path>#<n>. Going by name, not by HAS_EPISODE, also covers episodes
    # that `index` added after the last bridge.
    "mentions": "MATCH (e:Episodic)-[:MENTIONS]->(n:Entity) "
                "RETURN split(e.name, '#')[0] AS path, n.uuid AS t, count(*) AS c",
}


def _day(value) -> str | None:
    """A Neo4j DateTime (or an ISO string) as YYYY-MM-DD."""
    if value is None:
        return None
    if hasattr(value, "iso_format"):
        return value.iso_format()[:10]
    return str(value)[:10] or None


def _folder(path: str) -> str:
    """The folder a file is filed under, two levels deep, like projects/apollo."""
    parts = PurePosixPath(path).parts[:-1]
    return "/".join(parts[:2]) if parts else "(root)"


def collect(settings: Settings) -> dict:
    """Reads both layers from Neo4j into the compact shape the viewer expects."""
    with GraphDatabase.driver(
        settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password), notifications_min_severity="OFF"
    ) as driver:
        rows = {name: driver.execute_query(q)[0] for name, q in QUERIES.items()}

    # Files first, then entities. Every edge points at a node by its index in this list.
    files, index, by_path = [], {}, {}

    def add_file(key, path, title, type_, status, in_scope) -> int:
        index[key] = len(files)
        by_path[path] = index[key]
        files.append({"key": key, "path": path, "title": title or PurePosixPath(path).stem, "type": type_ or "file",
                      "status": status or "", "folder": _folder(path), "in_scope": bool(in_scope)})
        return index[key]

    for r in rows["files"]:
        add_file(r["key"], r["path"] or r["key"], r["title"], r["type"], r["status"], r["in_scope"])

    def file_for(path: str) -> int:
        # A file indexed after the last `structure` run has episodes but no Document node yet.
        if path not in by_path:
            add_file(path, path, None, "file", "", True)
        return by_path[path]

    episode_file = {r["id"]: file_for(r["name"].split("#")[0]) for r in rows["episodes"] if r["name"]}
    mentions = [(file_for(r["path"]), r["t"], r["c"]) for r in rows["mentions"] if r["path"]]

    base = len(files)
    entities = []
    for r in rows["entities"]:
        index[r["id"]] = base + len(entities)
        labels = [x for x in (r["labels"] or []) if x != "Entity"]
        entities.append([r["id"], r["name"] or "?", (r["summary"] or "").strip(), labels])

    layer1 = [[index[r["s"]], index[r["t"]], r["rel"], r["field"]] for r in rows["layer1"]]
    facts = []
    for r in rows["facts"]:
        if r["s"] not in index or r["t"] not in index:
            continue
        sources = sorted({episode_file[e] for e in (r["episodes"] or []) if e in episode_file})
        facts.append([index[r["s"]], index[r["t"]], r["rel"] or "", r["fact"] or "",
                      _day(r["valid_at"]), _day(r["invalid_at"]), sources])
    mention_rows = [[f, index[t], c] for f, t, c in mentions if t in index]

    return {
        "meta": {
            "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source_root": str(SOURCE_ROOT),
        },
        "files": files,
        "entities": entities,
        "layer1": layer1,
        "facts": facts,
        "mentions": mention_rows,
    }


def render(data: dict) -> str:
    """The page, with the libraries, the viewer code and the data inlined."""
    page = (STATIC / "viewer.html").read_text(encoding="utf-8")
    libs = "\n".join(f"<script>/* {name} */\n{(STATIC / name).read_text(encoding='utf-8')}\n</script>" for name in LIBS)
    app = (STATIC / "viewer.js").read_text(encoding="utf-8")
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    # str.replace, not format(): the libraries are full of braces.
    return (page.replace("<!--__LIBS__-->", libs)
                .replace("/*__DATA__*/null", payload)
                .replace("/*__APP__*/", app))


def write_html(settings: Settings) -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / "graph.html"
    out.write_text(render(collect(settings)), encoding="utf-8")
    return str(out)
