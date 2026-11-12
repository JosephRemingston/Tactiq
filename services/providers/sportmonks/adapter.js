import { ProviderNotConfiguredError } from "../provider.js";
/**
 * Placeholder for the first commercial feed (PDF section 9, stage 2). Implements the same contract so the
 * ingestion pipeline and its contract tests stay provider-agnostic. Every call fails until it is implemented.
 */
export class SportmonksAdapter {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.provider = "sportmonks";
  }
  capabilities() {
    return {
      lineups: true,
      events: true,
      freezeFrames: "none",
      tracking: false,
      video: false,
      xg: "provider",
      live: true,
      coordinateSystem: { length: 100, width: 100, perTeamNormalized: false },
      licenceId: "sportmonks-commercial",
    };
  }
  fail() {
    throw new ProviderNotConfiguredError(
      this.apiToken
        ? "Sportmonks adapter is not implemented yet (planned for production data, PDF section 9)"
        : "SPORTMONKS_API_TOKEN is not set",
    );
  }
  get normalizer() {
    return this.fail();
  }
  listCompetitions(..._args) {
    return Promise.resolve().then(() => this.fail());
  }
  listMatches(..._args) {
    return Promise.resolve().then(() => this.fail());
  }
  getLineups(..._args) {
    return Promise.resolve().then(() => this.fail());
  }
  getEvents(..._args) {
    return Promise.resolve().then(() => this.fail());
  }
  getFreezeFrames(..._args) {
    return Promise.resolve().then(() => this.fail());
  }
}
