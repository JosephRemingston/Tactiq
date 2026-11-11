import { type ProviderAdapter, type ProviderCapabilities, type ProviderNormalizer, ProviderNotConfiguredError, type RawPayload } from '../provider';

/**
 * Placeholder for the first commercial feed (PDF section 9, stage 2). Implements the same contract so the
 * ingestion pipeline and its contract tests stay provider-agnostic. Every call fails until it is implemented.
 */
export class SportmonksAdapter implements ProviderAdapter {
  readonly provider = 'sportmonks' as const;

  constructor(private readonly apiToken: string | undefined) {}

  capabilities(): ProviderCapabilities {
    return {
      lineups: true,
      events: true,
      freezeFrames: 'none',
      tracking: false,
      video: false,
      xg: 'provider',
      live: true,
      coordinateSystem: { length: 100, width: 100, perTeamNormalized: false },
      licenceId: 'sportmonks-commercial',
    };
  }

  private fail(): never {
    throw new ProviderNotConfiguredError(
      this.apiToken ? 'Sportmonks adapter is not implemented yet (planned for production data, PDF section 9)' : 'SPORTMONKS_API_TOKEN is not set',
    );
  }

  get normalizer(): ProviderNormalizer {
    return this.fail();
  }
  listCompetitions(..._args: unknown[]): Promise<RawPayload> {
    return Promise.resolve().then(() => this.fail());
  }
  listMatches(..._args: unknown[]): Promise<RawPayload> {
    return Promise.resolve().then(() => this.fail());
  }
  getLineups(..._args: unknown[]): Promise<RawPayload> {
    return Promise.resolve().then(() => this.fail());
  }
  getEvents(..._args: unknown[]): Promise<RawPayload> {
    return Promise.resolve().then(() => this.fail());
  }
  getFreezeFrames(..._args: unknown[]): Promise<RawPayload | null> {
    return Promise.resolve().then(() => this.fail());
  }
}
