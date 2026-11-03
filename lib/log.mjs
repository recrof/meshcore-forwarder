// journalctl-friendly: single line per event, no ANSI, with level prefix.
// Timestamps are off by default (journald adds its own); enable via config.logTimestamps.
const opts = { timestamps: false, debug: false };

export function configureLogging({ timestamps, debug } = {}) {
  if (timestamps !== undefined) opts.timestamps = !!timestamps;
  if (debug !== undefined) opts.debug = !!debug;
}

export function isDebug() {
  return opts.debug;
}

function fmt(level, scope, msg) {
  const line = `${level} [${scope}] ${msg}`;
  return opts.timestamps ? `${new Date().toISOString()} ${line}` : line;
}

export function makeLogger(scope) {
  return {
    debug: (msg) => { if (opts.debug) console.log(fmt('DEBUG', scope, msg)); },
    info: (msg) => console.log(fmt('INFO', scope, msg)),
    warn: (msg) => console.log(fmt('WARN', scope, msg)),
    error: (msg) => console.error(fmt('ERROR', scope, msg)),
  };
}
