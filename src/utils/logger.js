'use strict';

// ─── Colored, timestamped console logger ───────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE   = '\x1b[34m';
const CYAN   = '\x1b[36m';
const WHITE  = '\x1b[37m';

function timestamp() {
  return new Date().toLocaleString('en-ET', {
    timeZone: 'Africa/Addis_Ababa',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function format(level, color, msg, extra) {
  const ts   = `${DIM}[${timestamp()}]${RESET}`;
  const tag  = `${BOLD}${color}[${level.padEnd(5)}]${RESET}`;
  const body = `${WHITE}${msg}${RESET}`;
  const tail = extra ? `${DIM} ${JSON.stringify(extra)}${RESET}` : '';
  return `${ts} ${tag} ${body}${tail}`;
}

const logger = {
  info : (msg, extra) => console.log(format('INFO',  BLUE,   msg, extra)),
  ok   : (msg, extra) => console.log(format('OK',    GREEN,  msg, extra)),
  warn : (msg, extra) => console.warn(format('WARN',  YELLOW, msg, extra)),
  error: (msg, extra) => console.error(format('ERROR', RED,    msg, extra)),
  dim  : (msg)        => console.log(`${DIM}  ${msg}${RESET}`),
  step : (emoji, msg) => console.log(`\n${BOLD}${CYAN}${emoji}  ${msg}${RESET}`),
};

module.exports = logger;
