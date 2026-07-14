# Contributing to Corral

Thanks for your interest in Corral. It is a small, thin orchestrator by design, so contributions that keep it small are the most welcome.

## Guiding principle

Corral orchestrates; it does not infer. Anything about the quality or speed of generation belongs upstream in llama.cpp or MLX. Corral's job is limited to: pulling GGUF files, hot-swapping models, proxying the OpenAI API, and supervising backend processes. Please keep pull requests within that scope.

## Development setup

```bash
git clone https://github.com/JaydenCJ/corral.git
cd corral
npm install
npm run build
```

## Checks before opening a PR

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (uses the deterministic MockBackend, no network)
npm run build       # emit dist/
bash scripts/smoke.sh
```

All tests run against the in-repo `MockBackend` and a fake Hugging Face client. Tests must never touch the network or download model weights.

## Conventions

- Code comments and user-facing CLI output are in English.
- New inference backends implement the `Backend` interface in `src/backend/backend.ts` and are covered by tests through the mock server, not a real model.
- Keep the server bound to `127.0.0.1` by default and never log secrets.

## Good first issues

Look for the [good first issue](https://github.com/JaydenCJ/corral/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label, or start a [discussion](https://github.com/JaydenCJ/corral/discussions).
