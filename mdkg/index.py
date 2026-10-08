"""Layer 2: Graphiti reads each episode and extracts entities and facts. This is the part
that calls Bedrock and costs money, so every run has a budget and writes a cost report."""

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import anthropic
from graphiti_core.nodes import EpisodeType
from graphiti_core.utils.bulk_utils import RawEpisode

from .clients import EmbedUsage, build_graphiti
from .config import RUNS_DIR, STATE_FILE, Settings
from .scope import Episode

# Rough shape of Graphiti's work per episode, used only for the estimate before a run.
CALLS_PER_EPISODE = (6, 14)
PROMPT_OVERHEAD_TOKENS = (1500, 3500)
OUTPUT_TOKENS_PER_CALL = (150, 600)


@dataclass
class Spend:
    llm_in: int = 0
    llm_out: int = 0
    embed: int = 0
    per_prompt: dict = field(default_factory=dict)

    def usd(self, s: Settings) -> float:
        return (self.llm_in * s.price_llm_input + self.llm_out * s.price_llm_output + self.embed * s.price_embed) / 1e6


def estimate(episodes: list[Episode], s: Settings) -> tuple[float, float]:
    """A low and a high guess, in USD. The real number comes from the first run."""
    out = []
    for i in (0, 1):
        llm_in = sum(CALLS_PER_EPISODE[i] * (PROMPT_OVERHEAD_TOKENS[i] + int(e.words * 1.4)) for e in episodes)
        llm_out = sum(CALLS_PER_EPISODE[i] * OUTPUT_TOKENS_PER_CALL[i] for _ in episodes)
        embed = sum(int(e.words * 1.4) * (2 + i * 3) for e in episodes)
        out.append(Spend(llm_in, llm_out, embed).usd(s))
    return out[0], out[1]


def load_state() -> dict:
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def pending(episodes: list[Episode]) -> list[Episode]:
    """Only episodes that are new or whose text changed since the last run."""
    state = load_state()
    return [e for e in episodes if state.get(e.name, {}).get("digest") != e.digest]


def _llm_totals(llm) -> tuple[int, int, dict]:
    usage = llm.token_tracker.get_usage()
    per_prompt = {
        name: {"calls": u.call_count, "input": u.total_input_tokens, "output": u.total_output_tokens}
        for name, u in usage.items()
    }
    return sum(u.total_input_tokens for u in usage.values()), sum(u.total_output_tokens for u in usage.values()), per_prompt


def _describe(ep: Episode) -> str:
    return f"{ep.doc.doc_type or 'markdown'} document"


REFUSED = (anthropic.AuthenticationError, anthropic.PermissionDeniedError, anthropic.NotFoundError)


async def _run_bulk(graphiti, llm, embed_usage, episodes, s, max_cost, batch, state, report, spend) -> None:
    """Batches of episodes through add_episode_bulk: extraction runs in parallel inside a
    batch, and duplicates are merged within the batch. Much faster for a first load. Episodes
    in the same batch do not see each other while they are extracted, so a few more
    duplicate entities can slip through than in one-at-a-time mode."""
    done = 0
    for start in range(0, len(episodes), batch):
        chunk = episodes[start:start + batch]
        if spend.usd(s) >= max_cost:
            report["stopped_early"] = f"budget of ${max_cost:.2f} reached"
            print(f"Stopping: {report['stopped_early']}.")
            return

        before = Spend(spend.llm_in, spend.llm_out, spend.embed)
        started = time.monotonic()
        try:
            for ep in chunk:
                old = state.get(ep.name, {}).get("uuid")
                if old:
                    try:
                        await graphiti.remove_episode(old)
                    except Exception:
                        pass  # already gone
            result = await graphiti.add_episode_bulk(
                [
                    RawEpisode(
                        name=ep.name, content=ep.text, source=EpisodeType.text,
                        source_description=_describe(ep), reference_time=ep.doc.reference_time,
                    )
                    for ep in chunk
                ],
                group_id=s.group_id,
            )
        except REFUSED as err:
            report["stopped_early"] = f"{type(err).__name__}: {err}"
            print(f"Stopping, Bedrock refused the call: {err}")
            return
        except Exception as err:  # the batch stays pending; the next run retries it
            report["episodes"].append({"batch": [e.name for e in chunk], "error": f"{type(err).__name__}: {err}"})
            print(f"[{done}/{len(episodes)}] batch starting at {chunk[0].name}  FAILED: {err}")
            continue
        finally:
            spend.llm_in, spend.llm_out, spend.per_prompt = _llm_totals(llm)
            spend.embed = embed_usage.tokens

        by_name = {ep.name: ep for ep in chunk}
        for node in result.episodes:
            if node.name in by_name:
                state[node.name] = {"digest": by_name[node.name].digest, "uuid": node.uuid}
        save_state(state)
        done += len(chunk)
        row = {
            "batch": [e.name for e in chunk], "words": sum(e.words for e in chunk),
            "seconds": round(time.monotonic() - started, 1),
            "entities": len(result.nodes), "facts": len(result.edges),
            "llm_in": spend.llm_in - before.llm_in, "llm_out": spend.llm_out - before.llm_out,
            "embed": spend.embed - before.embed,
        }
        row["usd"] = round(Spend(row["llm_in"], row["llm_out"], row["embed"]).usd(s), 5)
        report["episodes"].append(row)
        print(
            f"[{done}/{len(episodes)}] batch of {len(chunk)} ({row['words']:,} words)  {row['entities']} entities, "
            f"{row['facts']} facts, {row['seconds']}s, ${row['usd']:.4f}  (total ${spend.usd(s):.4f})  up to {chunk[-1].name}"
        )


async def run(episodes: list[Episode], s: Settings, max_cost: float, batch: int = 1) -> dict:
    embed_usage = EmbedUsage()
    graphiti, llm = build_graphiti(s, embed_usage)
    state = load_state()
    report = {
        "started": datetime.now(timezone.utc).isoformat(),
        "llm_model": s.llm_model, "embedding_model": s.embedding_model, "region": s.aws_region,
        "prices_per_mtok": {"llm_input": s.price_llm_input, "llm_output": s.price_llm_output, "embed": s.price_embed},
        "max_cost_usd": max_cost, "batch": batch, "episodes": [], "stopped_early": None,
    }
    spend = Spend()
    try:
        await graphiti.build_indices_and_constraints()
        if batch > 1:
            await _run_bulk(graphiti, llm, embed_usage, episodes, s, max_cost, batch, state, report, spend)
        for n, ep in enumerate(episodes if batch <= 1 else [], 1):
            if spend.usd(s) >= max_cost:
                report["stopped_early"] = f"budget of ${max_cost:.2f} reached"
                print(f"Stopping: {report['stopped_early']}.")
                break

            before = Spend(spend.llm_in, spend.llm_out, spend.embed)
            started = time.monotonic()
            old = state.get(ep.name, {}).get("uuid")
            try:
                if old:
                    try:
                        await graphiti.remove_episode(old)
                    except Exception:
                        pass  # already gone, for example after a database reset
                result = await graphiti.add_episode(
                    name=ep.name,
                    episode_body=ep.text,
                    source=EpisodeType.text,
                    source_description=_describe(ep),
                    reference_time=ep.doc.reference_time,
                    group_id=s.group_id,
                )
            except REFUSED as err:
                report["stopped_early"] = f"{type(err).__name__}: {err}"
                print(f"Stopping, Bedrock refused the call: {err}")
                break
            except Exception as err:  # one bad episode should not lose the whole run
                report["episodes"].append({"name": ep.name, "error": f"{type(err).__name__}: {err}"})
                print(f"[{n}/{len(episodes)}] {ep.name}  FAILED: {err}")
                continue
            finally:
                spend.llm_in, spend.llm_out, spend.per_prompt = _llm_totals(llm)
                spend.embed = embed_usage.tokens

            state[ep.name] = {"digest": ep.digest, "uuid": result.episode.uuid}
            save_state(state)
            row = {
                "name": ep.name, "words": ep.words, "seconds": round(time.monotonic() - started, 1),
                "entities": len(result.nodes), "facts": len(result.edges),
                "llm_in": spend.llm_in - before.llm_in, "llm_out": spend.llm_out - before.llm_out,
                "embed": spend.embed - before.embed,
            }
            row["usd"] = round(Spend(row["llm_in"], row["llm_out"], row["embed"]).usd(s), 5)
            report["episodes"].append(row)
            print(
                f"[{n}/{len(episodes)}] {ep.name}  {row['entities']} entities, {row['facts']} facts, "
                f"{row['seconds']}s, ${row['usd']:.4f}  (total ${spend.usd(s):.4f})"
            )
    finally:
        await graphiti.close()

    report["finished"] = datetime.now(timezone.utc).isoformat()
    report["totals"] = {
        "llm_input_tokens": spend.llm_in, "llm_output_tokens": spend.llm_out,
        "embedding_tokens": spend.embed, "embedding_calls": embed_usage.calls,
        "usd": round(spend.usd(s), 5),
    }
    report["per_prompt"] = spend.per_prompt
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    path = RUNS_DIR / f"{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.json"
    path.write_text(json.dumps(report, indent=2))
    report["_path"] = str(path)
    return report
