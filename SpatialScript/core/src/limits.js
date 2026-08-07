// Every bound the core enforces on script-supplied work, in one place so the
// declarations and the docs can name the same numbers (SPEC 2 robustness rule,
// SPEC 3.13 console budget).

/** Object and material names past this are truncated with a warning. */
export const MAX_NAME_LENGTH = 256;

/** A single formatted console message is truncated past this. */
export const MAX_LOG_MESSAGE = 16 * 1024;

/** Log commands emitted in one frame; the rest are counted in one summary. */
export const MAX_LOGS_PER_FRAME = 200;

/** Entries kept in dump().warnings and dump().errors. */
export const MAX_RECORDED_WARNINGS = 500;
export const MAX_RECORDED_ERRORS = 200;

/** Live setTimeout/setInterval registrations, and live rAF registrations. */
export const MAX_LIVE_TIMERS = 10000;
export const MAX_LIVE_FRAME_CALLBACKS = 10000;

/** Timer and animation-frame callbacks run in one tick; the rest defer. */
export const MAX_CALLBACKS_PER_TICK = 10000;

/** Listeners registered on one object for one event type. */
export const MAX_LISTENERS_PER_EVENT = 1000;

/** Scene graph depth; an edit that would exceed it is refused. */
export const MAX_DEPTH = 1024;

/** Ids must stay exact in the float32 `transforms` records. */
export const MAX_ID = 1 << 24;

/** Geometry `parameters`: string length, array length, and key count. */
export const MAX_PARAMETER_STRING = 256;
export const MAX_PARAMETER_ARRAY = 64;
export const MAX_PARAMETER_KEYS = 64;

/** Url schemes a texture or asset may use. */
export const ALLOWED_URL_SCHEMES = ["https:", "http:", "file:", "asset:", "data:"];
