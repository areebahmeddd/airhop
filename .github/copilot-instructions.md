# Airhop: Copilot Instructions

> Loaded by GitHub Copilot for every session in this repository. It points to the project's agent guide rather than repeating it.

**Airhop** is a React Native (Expo bare workflow) iOS and Android app for offline-first, end-to-end encrypted messaging over a Bluetooth mesh, wire-compatible with bitchat.

## Before Any Suggestion

Read [`AGENTS.md`](../AGENTS.md) at the repository root in full. It is the canonical guide for every agent here, Copilot included: where things live, the crypto, storage, protocol, native, copy, TypeScript, design and comment rules, and the four documents to read before writing code. Follow it exactly; where this file and `AGENTS.md` could disagree, `AGENTS.md` wins.

Before working on a subsystem, also read its skill in [`skills/`](skills/). `AGENTS.md` lists which skill covers what.

## Review Agents

Three review agents live in [`agents/`](agents/): Architect, Security Review and Upstream Sync. Pick one from the agent dropdown in Copilot Chat. `AGENTS.md` says when each one runs.
