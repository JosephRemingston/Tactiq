import { SportmonksAdapter } from "./sportmonks/adapter.js";
import { StatsBombOpenDataAdapter } from "./statsbomb/adapter.js";
import { HttpTransport, LocalDirTransport } from "./statsbomb/transport.js";
export class ProviderRegistry {
  constructor(config, limiter) {
    this.config = config;
    this.limiter = limiter;
    this.adapters = new Map();
  }
  get(provider) {
    let adapter = this.adapters.get(provider);
    if (!adapter) {
      adapter = provider === "statsbomb" ? this.statsBomb() : new SportmonksAdapter(this.config.SPORTMONKS_API_TOKEN);
      this.adapters.set(provider, adapter);
    }
    return adapter;
  }
  /** Overrides the StatsBomb source (e.g. the CLI's --local flag). */
  useStatsBombLocalDir(dir) {
    this.adapters.set("statsbomb", new StatsBombOpenDataAdapter(new LocalDirTransport(dir)));
  }
  statsBomb() {
    if (this.config.STATSBOMB_SOURCE === "local") {
      if (!this.config.STATSBOMB_OPEN_DATA_LOCAL_DIR)
        throw new Error("STATSBOMB_OPEN_DATA_LOCAL_DIR is required when STATSBOMB_SOURCE=local");
      return new StatsBombOpenDataAdapter(new LocalDirTransport(this.config.STATSBOMB_OPEN_DATA_LOCAL_DIR));
    }
    return new StatsBombOpenDataAdapter(
      new HttpTransport(this.config.STATSBOMB_OPEN_DATA_BASE_URL, this.config.STATSBOMB_USER_AGENT, () =>
        this.limiter.acquire("statsbomb"),
      ),
    );
  }
}
