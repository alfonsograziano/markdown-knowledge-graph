"""The four pieces Graphiti needs: LLM (Haiku on Bedrock), embedder (Titan on Bedrock),
reranker (a pass-through, so none) and graph store (Neo4j)."""

import asyncio
import json

import boto3
from anthropic import AsyncAnthropicBedrock
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client.anthropic_client import AnthropicClient
from graphiti_core.llm_client.config import LLMConfig

from .config import Settings

# Titan V2 takes up to 8k tokens; cut well before that.
TITAN_MAX_CHARS = 30_000


class EmbedUsage:
    def __init__(self) -> None:
        self.tokens = 0
        self.calls = 0


class BedrockTitanEmbedder(EmbedderClient):
    """Graphiti has no Bedrock embedder, so this one calls Titan Text Embeddings V2."""

    def __init__(self, settings: Settings, usage: EmbedUsage, max_concurrency: int = 4):
        session = boto3.Session(
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
            aws_session_token=settings.aws_session_token,
            region_name=settings.aws_region,
        )
        self.client = session.client("bedrock-runtime")
        self.model_id = settings.embedding_model
        self.dim = settings.embedding_dim
        self.usage = usage
        self.semaphore = asyncio.Semaphore(max_concurrency)

    def _embed(self, text: str) -> list[float]:
        body = json.dumps({"inputText": text[:TITAN_MAX_CHARS] or " ", "dimensions": self.dim, "normalize": True})
        response = self.client.invoke_model(
            modelId=self.model_id, body=body, contentType="application/json", accept="application/json"
        )
        payload = json.loads(response["body"].read())
        self.usage.tokens += int(payload.get("inputTextTokenCount", 0))
        self.usage.calls += 1
        return payload["embedding"]

    async def create(self, input_data) -> list[float]:
        if isinstance(input_data, str):
            text = input_data
        elif isinstance(input_data, list) and input_data and isinstance(input_data[0], str):
            text = input_data[0]
        else:
            raise TypeError("BedrockTitanEmbedder only embeds text")
        async with self.semaphore:
            return await asyncio.to_thread(self._embed, text)

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return list(await asyncio.gather(*(self.create(t) for t in input_data_list)))


class PassthroughReranker(CrossEncoderClient):
    """No reranking: keeps the order the search already produced. Graphiti only calls this
    in the advanced search recipes, never while indexing. Passing it also stops Graphiti
    from falling back to its OpenAI reranker. Swap in Cohere Rerank 3.5 on Bedrock later
    if search quality needs it."""

    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        n = len(passages)
        return [(p, (n - i) / n) for i, p in enumerate(passages)]


class _MessagesWithoutSampling:
    def __init__(self, messages) -> None:
        self._messages = messages

    async def create(self, **kwargs):
        kwargs.pop("temperature", None)
        kwargs.pop("top_p", None)
        kwargs.pop("top_k", None)
        return await self._messages.create(**kwargs)

    def __getattr__(self, name):
        return getattr(self._messages, name)


class GraphitiCompatibleClient:
    """anthropic 1.x removed temperature/top_p/top_k from messages.create (a TypeError),
    but graphiti-core 0.30.2 still sends temperature on every call. Haiku 5.5 only allows
    the default value anyway, so dropping it changes nothing."""

    def __init__(self, client) -> None:
        self._client = client
        self.messages = _MessagesWithoutSampling(client.messages)

    def __getattr__(self, name):
        return getattr(self._client, name)


def anthropic_bedrock(settings: Settings) -> AsyncAnthropicBedrock:
    # The classic bedrock-runtime client. The newer Mantle endpoint returned 404 for
    # Haiku 5.5 in eu-west-1 (tested 2026-10-08), and the plain model id is not offered
    # on demand there, so LLM_MODEL must be the EU inference profile id.
    return AsyncAnthropicBedrock(
        aws_access_key=settings.aws_access_key_id,
        aws_secret_key=settings.aws_secret_access_key,
        aws_session_token=settings.aws_session_token,
        aws_region=settings.aws_region,
    )


def build_graphiti(settings: Settings, embed_usage: EmbedUsage) -> tuple[Graphiti, AnthropicClient]:
    settings.require_aws()
    llm = AnthropicClient(
        config=LLMConfig(model=settings.llm_model, small_model=settings.llm_model),
        client=GraphitiCompatibleClient(anthropic_bedrock(settings)),
    )
    graphiti = Graphiti(
        settings.neo4j_uri,
        settings.neo4j_user,
        settings.neo4j_password,
        llm_client=llm,
        embedder=BedrockTitanEmbedder(settings, embed_usage, settings.max_coroutines),
        cross_encoder=PassthroughReranker(),
        max_coroutines=settings.max_coroutines,
    )
    return graphiti, llm
