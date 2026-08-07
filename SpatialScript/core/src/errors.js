// SpatialScript error types.

export class SpatialUnsupportedError extends Error {
  constructor(message, feature = null, object = null) {
    super(message);
    this.name = "SpatialUnsupportedError";
    this.feature = feature;
    this.object = object;
  }
}

export class SpatialLoadError extends Error {
  constructor(message, line = null, column = null, cause = null) {
    super(message);
    this.name = "SpatialLoadError";
    this.line = line;
    this.column = column;
    this.cause = cause;
    // Errors constructed inside the bundle capture a stack full of core
    // frames, which is noise for whoever reads the failure. Keep the script's
    // own stack when there is one and otherwise carry no frames at all.
    const inherited = cause && typeof cause.stack === "string" ? cause.stack : null;
    this.stack = inherited === null ? `${this.name}: ${message}` : inherited;
  }
}

/**
 * The engine's own one-line description of an error: "TypeError: x is not a
 * function". Never carries stack frames, even when an engine or a script has
 * folded them into `message`.
 */
export function cleanMessage(error) {
  if (!error) return String(error);
  if (typeof error !== "object") return String(error);
  const name = typeof error.name === "string" && error.name.length > 0 ? error.name : "Error";
  const raw = typeof error.message === "string" ? error.message : String(error.message);
  const firstLine = raw.split("\n", 1)[0].trim();
  return firstLine.length === 0 ? name : `${name}: ${firstLine}`;
}

/**
 * Extracts a 1-based line and column from an Error produced by evaluating a
 * script. JavaScriptCore exposes `line` and `column` directly. V8 only exposes
 * a `stack` string; SpiderMonkey exposes `lineNumber` / `columnNumber`.
 *
 * `lineOffset` is the number of wrapper lines the engine counts before the
 * first line of user source (measured at runtime by probeLineOffset()).
 */
export function extractLocation(error, lineOffset = 0, allowStack = true) {
  let line = null;
  let column = null;

  if (error && typeof error === "object") {
    if (typeof error.line === "number" && Number.isFinite(error.line)) {
      line = error.line;
      if (typeof error.column === "number") column = error.column;
    } else if (typeof error.lineNumber === "number" && Number.isFinite(error.lineNumber)) {
      line = error.lineNumber;
      if (typeof error.columnNumber === "number") column = error.columnNumber;
    } else if (allowStack && typeof error.stack === "string") {
      const parsed = parseStack(error.stack);
      if (parsed) {
        line = parsed.line;
        column = parsed.column;
      }
    }
  }

  if (line === null) return { line: null, column: null };
  const adjusted = line - lineOffset;
  return { line: adjusted > 0 ? adjusted : null, column: column === null ? null : column };
}

/**
 * Finds the innermost "<anonymous>:LINE:COL" location in a V8-style stack.
 * Script code compiled through `new Function` is the only source that reports
 * as <anonymous>, so this never picks up a frame from the core bundle itself.
 */
function parseStack(stack) {
  const lines = stack.split("\n");
  for (const raw of lines) {
    const match = /<anonymous>:(\d+):(\d+)/.exec(raw);
    if (match) {
      return { line: Number(match[1]), column: Number(match[2]) };
    }
  }
  return null;
}

/**
 * Measures how many lines the host engine prepends when compiling a function
 * body through `new Function`. The probe throws on its own first source line,
 * so the reported line number minus one is the offset.
 */
export function probeLineOffset(parameterNames = []) {
  try {
    // eslint-disable-next-line no-new-func
    const probe = new Function(...parameterNames, "throw new Error('spatial-probe');");
    probe();
  } catch (error) {
    const { line } = extractLocation(error, 0);
    if (line !== null) return line - 1;
  }
  return 0;
}
