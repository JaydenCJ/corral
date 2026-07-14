/**
 * Public programmatic API for Corral. The CLI (`corral`) is the primary
 * interface; these exports let you embed the orchestrator, backends, and
 * Hugging Face pull pipeline in your own tooling.
 */
export { VERSION } from "./version.js";
export {
  type BackendKind,
  type CorralConfig,
  DEFAULT_CONFIG,
  loadConfig,
  parseBackendKind,
  saveConfig,
} from "./config.js";
export type {
  Backend,
  BackendInstance,
  ExitInfo,
  ModelSpec,
} from "./backend/backend.js";
export { ProcessBackendInstance } from "./backend/backend.js";
export { LlamaCppBackend, buildLlamaArgs } from "./backend/llamacpp.js";
export { MlxBackend, buildMlxArgs } from "./backend/mlx.js";
export { MockBackend } from "./backend/mock.js";
export { createBackend } from "./backend/factory.js";
export { ModelSupervisor, type PsEntry, type SupervisorOptions } from "./serve/supervisor.js";
export { createCorralServer, startServer, type ServeOptions, type RunningServer } from "./serve/server.js";
export { type Clock, FakeClock, systemClock } from "./serve/clock.js";
export {
  type HfDownloadHandle,
  type HfFileEntry,
  type HuggingFaceClient,
} from "./hf/client.js";
export { RealHuggingFaceClient } from "./hf/realClient.js";
export { MockHuggingFaceClient } from "./hf/mockClient.js";
export { extractQuant, isSplitGguf, type QuantSelection, selectGguf } from "./hf/quant.js";
export { pullModel, parsePullRef, type PullOptions, type PullRef } from "./commands/pull.js";
export {
  listManifests,
  type ModelManifest,
  readManifest,
  removeModel,
  resolveManifest,
  writeManifest,
} from "./manifest.js";
export { streamChat, isServerHealthy, type ChatMessage } from "./openaiClient.js";
