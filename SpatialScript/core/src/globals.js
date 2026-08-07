// Globals the core installs for a script (SPEC 3.13). Timers are driven by
// frame ticks and console output travels to the consumer as `log` commands.

const LEVELS = ["log", "warn", "error", "info", "debug"];

export function installGlobals(runtime, namespace) {
  const g = globalThis;

  g.Spatial = namespace;

  const spatialConsole = {};
  for (const level of LEVELS) {
    spatialConsole[level] = (...args) => {
      const message = runtime.log(level, args);
      // Warnings from anywhere, including three's own "Unknown color" notice,
      // are part of the scene dump.
      if (level === "warn") runtime.recordWarning(message);
    };
  }
  g.console = spatialConsole;

  g.setTimeout = (callback, delay, ...args) => runtime.timers.setTimeout(callback, delay, ...args);
  g.clearTimeout = (id) => runtime.timers.clearTimeout(id);
  g.setInterval = (callback, delay, ...args) => runtime.timers.setInterval(callback, delay, ...args);
  g.clearInterval = (id) => runtime.timers.clearInterval(id);
  g.requestAnimationFrame = (callback) => runtime.timers.requestAnimationFrame(callback);
  g.cancelAnimationFrame = (id) => runtime.timers.cancelAnimationFrame(id);
}
