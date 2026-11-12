/** Structured JSON logs, one line per entry, so Netlify and GitHub Actions logs stay searchable. */
export class Logger {
  constructor(name) {
    this.name = name;
  }

  write(level, msg, extra) {
    const line = JSON.stringify({ level, logger: this.name, msg, ...(extra ?? {}), at: new Date().toISOString() });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  log(msg, extra) {
    this.write("info", msg, extra);
  }

  warn(msg, extra) {
    this.write("warn", msg, extra);
  }

  error(msg, extra) {
    this.write("error", msg, extra);
  }

  debug(msg, extra) {
    if (process.env.LOG_LEVEL === "debug") this.write("debug", msg, extra);
  }
}

export default Logger;
