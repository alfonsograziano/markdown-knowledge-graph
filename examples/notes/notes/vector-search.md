---
title: Vector search notes
type: note
created: 2026-02-01
updated: 2026-03-05
---

# Vector search notes

Vector search finds documents by meaning instead of exact words. Each document becomes an embedding, and a query is matched to the closest embeddings.

## Hybrid search

Pure vector search misses exact terms like product codes. Hybrid search combines a keyword score (BM25) with the vector score, which fixes most of those misses. [[apollo]] uses hybrid search since the kickoff.

## Latency

An approximate nearest-neighbour index (HNSW) keeps queries fast on large collections, at the cost of a little recall.
