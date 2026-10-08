---
title: Apollo search revamp
type: project
status: active
created: 2026-02-10
people: [maria, tom]
---

# Apollo search revamp

Apollo replaces the keyword search in the help center with semantic search. The goal is to cut "no results" pages by half before the end of Q2.

## Plan

- Index the help-center articles with an embedding model. See [[vector-search]].
- Run an A/B test against the current search for two weeks.
- Ship to all users if the "no results" rate drops by at least 40%.

## Risks

Latency is the main risk. The current search answers in 80 ms, and the team agreed on a 200 ms budget for the new one.
