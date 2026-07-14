/**
 * Minimal logger. All diagnostic output goes to stderr so that stdout stays
 * reserved for machine-readable command output (JSON, model lists, REPL text).
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

const isDebug = (): boolean => process.env.CORRAL_DEBUG === "1";

/** Logger that writes human-readable lines to stderr. */
export const consoleLogger: Logger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`warning: ${m}\n`),
  error: (m) => process.stderr.write(`error: ${m}\n`),
  debug: (m) => {
    if (isDebug()) process.stderr.write(`debug: ${m}\n`);
  },
};

/** Logger that swallows everything. Used by tests to keep output clean. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
