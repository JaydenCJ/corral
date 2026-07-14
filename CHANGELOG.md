# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-08

### Added

- `corral pull <hf-repo>[:<quant>]` — resolve a Hugging Face repo's file list,
  select a GGUF by quant tag, and download it with resume support into
  `~/.corral/models/`, writing a manifest (source URL, size, quant, revision).
- `corral ls`, `corral show <model>`, `corral rm <model>` for local model
  management. No private registry: a model is the GGUF file on your disk.
- Backend abstraction with three implementations: `LlamaCppBackend` (upstream
  `llama-server`), `MlxBackend` (`mlx_lm.server`, Apple Silicon only), and a
  deterministic `MockBackend` for tests and demos.
- `corral serve` — an OpenAI-compatible HTTP server bound to `127.0.0.1` with
  `/v1/models`, `/v1/chat/completions`, `/v1/completions` (SSE streaming passed
  through), `/health`, and `/api/ps`. On-demand model start, LRU eviction past
  `maxLoaded`, idle reaping, and bounded crash restart.
- `corral run <model>` — a streaming terminal REPL (and `--prompt` one-shot)
  that talks to a running server or starts one inline.
- `corral ps` — list running models from a live server's `/api/ps`.
- Configuration via `~/.corral/config.json` with per-command flag overrides.

### Fixed

- `/v1/models` now also lists currently loaded models that have no local
  manifest (ephemeral ids served by the mock backend), so the model list always
  agrees with what `/v1/chat/completions` is actively serving.

### Notes

- The repository ships no CI workflow; verification is local — `npm ci && npm run build && npm test && bash scripts/smoke.sh`.

[0.1.0]: https://github.com/JaydenCJ/corral/releases/tag/v0.1.0
