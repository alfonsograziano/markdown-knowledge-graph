"""mdkg: build and explore a knowledge graph from a folder of markdown files.

  plan       what would be indexed, and a rough cost range. No network.
  structure  Layer 1: references and links into Neo4j. Local only, free.
  check      one tiny call to each Bedrock model, to prove the keys work.
  index      Layer 2: Graphiti on Bedrock. Costs money; asks first.
  search     ask the graph a question.
  status     what is in Neo4j right now.
  cost       the cost report of the last index run.
  viz        write data/graph.html, both layers in one picture, and open it.
"""

import argparse
import asyncio
import json
import logging
import sys

from .config import RUNS_DIR, load_settings
from .scope import docs_in_scope, episodes_for, load_scope


def _episodes(scope):
    return [ep for doc in docs_in_scope(scope) for ep in episodes_for(doc, scope.max_words)]


def cmd_plan(args) -> None:
    from .index import estimate, pending

    s, scope = load_settings(), load_scope()
    docs = docs_in_scope(scope)
    episodes = [ep for doc in docs for ep in episodes_for(doc, scope.max_words)]
    todo = pending(episodes)
    print(f"Scope: {', '.join(scope.include)}  (only {', '.join(scope.extensions)})")
    print(f"{len(docs)} files -> {len(episodes)} episodes, {sum(e.words for e in episodes):,} words\n")
    for doc in docs:
        eps = [e for e in episodes if e.doc is doc]
        print(f"  {doc.path}  {sum(e.words for e in eps):,} words, {len(eps)} episode(s)")
    low, high = estimate(todo, s)
    print(f"\n{len(todo)} episode(s) new or changed since the last run.")
    print(f"Rough cost for those: ${low:.3f} to ${high:.3f}, at the prices in .env.")
    print("This is a guess. The first real run prints the true number.")


def cmd_structure(args) -> None:
    from .structure import build, summary, write

    s, scope = load_settings(), load_scope()
    nodes, edges = build(scope)
    print(summary(nodes, edges))
    if args.dry_run:
        print("\nDry run: nothing written.")
        return
    write(s, nodes, edges)
    print("\nWritten to Neo4j. Open http://localhost:7474")


async def _check(s) -> None:
    from .clients import BedrockTitanEmbedder, EmbedUsage, anthropic_bedrock

    s.require_aws()
    client = anthropic_bedrock(s)
    msg = await client.messages.create(
        model=s.llm_model, max_tokens=1024,
        messages=[{"role": "user", "content": "Reply with the single word: ready"}],
    )
    text = " ".join(b.text for b in msg.content if b.type == "text").strip()
    print(f"LLM  {s.llm_model}: '{text}'  ({msg.usage.input_tokens} in, {msg.usage.output_tokens} out)")

    usage = EmbedUsage()
    vector = await BedrockTitanEmbedder(s, usage).create("hello world")
    print(f"Embed {s.embedding_model}: {len(vector)} dimensions ({usage.tokens} tokens)")
    if len(vector) != s.embedding_dim:
        print(f"Warning: expected {s.embedding_dim} dimensions. Fix EMBEDDING_DIM in .env.")


def cmd_check(args) -> None:
    asyncio.run(_check(load_settings()))
    print("Both models answered. Ready to index.")


def cmd_index(args) -> None:
    from .index import estimate, pending, run
    from .structure import bridge

    s, scope = load_settings(), load_scope()
    s.require_aws()
    todo = pending(_episodes(scope))
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("Nothing new or changed. Nothing to do.")
        return
    low, high = estimate(todo, s)
    print(f"{len(todo)} episode(s) to index. Rough cost ${low:.3f} to ${high:.3f}. Hard stop at ${args.max_cost:.2f}.")
    if not args.yes and input("Go? [y/N] ").strip().lower() != "y":
        print("Cancelled.")
        return
    report = asyncio.run(run(todo, s, args.max_cost, args.batch))
    bridge(s)
    t = report["totals"]
    print(
        f"\nDone. LLM {t['llm_input_tokens']:,} in / {t['llm_output_tokens']:,} out, "
        f"embeddings {t['embedding_tokens']:,} tokens. Cost ${t['usd']:.4f}."
    )
    print(f"Report: {report['_path']}")


async def _search(s, query: str, limit: int) -> None:
    from .clients import EmbedUsage, build_graphiti

    graphiti, _ = build_graphiti(s, EmbedUsage())
    try:
        edges = await graphiti.search(query, group_ids=[s.group_id], num_results=limit)
    finally:
        await graphiti.close()
    if not edges:
        print("No facts found.")
    for e in edges:
        when = e.valid_at.date().isoformat() if e.valid_at else "?"
        print(f"- {e.fact}  (since {when})")


def cmd_search(args) -> None:
    asyncio.run(_search(load_settings(), args.query, args.limit))


def cmd_status(args) -> None:
    from neo4j import GraphDatabase

    s = load_settings()
    queries = {
        "documents (layer 1)": "MATCH (n:Document) RETURN count(n) AS c",
        "entities (layer 2)": "MATCH (n:Entity) RETURN count(n) AS c",
        "episodes (layer 2)": "MATCH (n:Episodic) RETURN count(n) AS c",
        "facts (layer 2)": "MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS c",
    }
    with GraphDatabase.driver(s.neo4j_uri, auth=(s.neo4j_user, s.neo4j_password), notifications_min_severity="OFF") as driver:
        for label, q in queries.items():
            records, _, _ = driver.execute_query(q)
            print(f"{label:22} {records[0]['c']}")


def cmd_viz(args) -> None:
    import subprocess

    from .viz import write_html

    path = write_html(load_settings())
    print(f"Wrote {path}")
    if not args.no_open:
        subprocess.run(["open", path], check=False)


def cmd_cost(args) -> None:
    runs = sorted(RUNS_DIR.glob("*.json")) if RUNS_DIR.exists() else []
    if not runs:
        print("No index runs yet.")
        return
    report = json.loads(runs[-1].read_text())
    print(f"Last run: {runs[-1].name}")
    print(json.dumps(report["totals"], indent=2))
    print("\nBy Graphiti prompt:")
    for name, u in sorted(report.get("per_prompt", {}).items(), key=lambda kv: -kv[1]["input"]):
        print(f"  {name:45} {u['calls']:4} calls  {u['input']:>9,} in  {u['output']:>8,} out")


class _DropKnownNoise(logging.Filter):
    """Graphiti creates its indexes in parallel, so Neo4j reports some as already existing."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "EquivalentSchemaRuleAlreadyExists" not in record.getMessage()


def _quiet_logs() -> None:
    # Neo4j warns about labels and properties that do not exist yet in a young graph.
    logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)
    for handler in logging.getLogger().handlers or [logging.lastResort]:
        handler.addFilter(_DropKnownNoise())
    logging.getLogger("graphiti_core").addFilter(_DropKnownNoise())


def main() -> None:
    _quiet_logs()
    parser = argparse.ArgumentParser(prog="mdkg", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan").set_defaults(func=cmd_plan)
    p = sub.add_parser("structure")
    p.add_argument("--dry-run", action="store_true", help="print what would be written, touch nothing")
    p.set_defaults(func=cmd_structure)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("index")
    p.add_argument("--max-cost", type=float, default=1.00, help="stop when this many USD are spent (default 1.00)")
    p.add_argument("--limit", type=int, help="index at most this many episodes")
    p.add_argument("--batch", type=int, default=1, help="episodes per bulk batch; 1 = one at a time (best quality)")
    p.add_argument("--yes", action="store_true", help="do not ask before starting")
    p.set_defaults(func=cmd_index)
    p = sub.add_parser("search")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_search)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("cost").set_defaults(func=cmd_cost)
    p = sub.add_parser("viz")
    p.add_argument("--no-open", action="store_true", help="write the file but do not open it")
    p.set_defaults(func=cmd_viz)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
