"""Settings, read from .env. Import this module before graphiti_core so telemetry stays off."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_DIR / "data"
RUNS_DIR = DATA_DIR / "runs"
STATE_FILE = DATA_DIR / "index-state.json"

load_dotenv(PROJECT_DIR / ".env")
os.environ.setdefault("GRAPHITI_TELEMETRY_ENABLED", "false")


def _source_root() -> Path:
    """The folder of markdown files to index. Relative paths are read from the project folder."""
    root = Path(os.environ.get("SOURCE_DIR", "examples/notes").strip()).expanduser()
    return root if root.is_absolute() else (PROJECT_DIR / root).resolve()


SOURCE_ROOT = _source_root()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_session_token: str | None
    aws_region: str
    llm_model: str
    embedding_model: str
    embedding_dim: int
    price_llm_input: float
    price_llm_output: float
    price_embed: float
    neo4j_uri: str
    neo4j_user: str
    neo4j_password: str
    group_id: str
    max_coroutines: int

    def require_aws(self) -> None:
        """Fail early, with a clear message, instead of falling back to ~/.aws."""
        missing = [
            name
            for name, value in [
                ("AWS_ACCESS_KEY_ID", self.aws_access_key_id),
                ("AWS_SECRET_ACCESS_KEY", self.aws_secret_access_key),
                ("AWS_REGION", self.aws_region),
            ]
            if not value
        ]
        if missing:
            raise SystemExit(f"Missing in {PROJECT_DIR / '.env'}: {', '.join(missing)}")


def load_settings() -> Settings:
    return Settings(
        aws_access_key_id=_env("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("AWS_SECRET_ACCESS_KEY"),
        aws_session_token=_env("AWS_SESSION_TOKEN") or None,
        aws_region=_env("AWS_REGION"),
        llm_model=_env("LLM_MODEL", "anthropic.claude-haiku-5-5"),
        embedding_model=_env("EMBEDDING_MODEL", "amazon.titan-embed-text-v2:0"),
        embedding_dim=int(_env("EMBEDDING_DIM", "1024")),
        price_llm_input=float(_env("PRICE_LLM_INPUT_PER_MTOK", "0.10")),
        price_llm_output=float(_env("PRICE_LLM_OUTPUT_PER_MTOK", "0.50")),
        price_embed=float(_env("PRICE_EMBED_PER_MTOK", "0.02")),
        neo4j_uri=_env("NEO4J_URI", "bolt://localhost:7687"),
        neo4j_user=_env("NEO4J_USER", "neo4j"),
        neo4j_password=_env("NEO4J_PASSWORD"),
        group_id=_env("GROUP_ID", "default"),
        max_coroutines=int(_env("SEMAPHORE_LIMIT", "12")),
    )
