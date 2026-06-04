// journalctl-friendly: single line per event, no ANSI, with level prefix.
function fmt(level, scope, msg) {
  return `${level} [${scope}] ${msg}`;
}

export function makeLogger(scope) {
  return {
    info: (msg) => console.log(fmt('INFO', scope, msg)),
    warn: (msg) => console.log(fmt('WARN', scope, msg)),
    error: (msg) => console.error(fmt('ERROR', scope, msg)),
  };
}
