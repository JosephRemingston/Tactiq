import PLACEMENTS from "../data/ad_placements.json" with { type: "json" };

/** Google's public AdMob test units: safe to show in development and staging. */
const TEST_UNITS = {
  native: "ca-app-pub-3940256099942544/2247696110",
  banner: "ca-app-pub-3940256099942544/6300978111",
};

/**
 * Server-driven ad configuration (PDF section 6). AdMob itself runs in the Android app; the backend decides
 * whether ads may show for this user and where. The response holds placement metadata only: no player data,
 * notes or anything else about the user is ever sent towards an ad network.
 */
export class AdsService {
  constructor(entitlements, config) {
    this.entitlements = entitlements;
    this.config = config;
  }

  units() {
    const production = this.config.NODE_ENV === "production";
    return {
      native: this.config.ADMOB_NATIVE_UNIT_ID ?? (production ? null : TEST_UNITS.native),
      banner: this.config.ADMOB_BANNER_UNIT_ID ?? (production ? null : TEST_UNITS.banner),
    };
  }

  /** Anonymous visitors are on the free experience; signed-in users follow their `ads.enabled` entitlement. */
  async enabledFor(userId) {
    if (!userId) return true;
    return this.entitlements.isEnabled(userId, "ads.enabled");
  }

  async config_(userId) {
    const enabled = await this.enabledFor(userId);
    const units = this.units();
    const placements = enabled
      ? PLACEMENTS.placements
          .map(({ unit, ...p }) => ({ ...p, adUnitId: units[unit] }))
          // A placement without a configured unit id is not served (production before AdMob is set up).
          .filter((p) => p.adUnitId)
      : [];
    return {
      enabled: enabled && placements.length > 0,
      reason: enabled ? (placements.length ? null : "not_configured") : "plan",
      network: PLACEMENTS.network,
      version: PLACEMENTS.version,
      testUnits: placements.some((p) => Object.values(TEST_UNITS).includes(p.adUnitId)),
      placements,
      adFreeScreens: PLACEMENTS.adFreeScreens,
      frequency: PLACEMENTS.frequency,
      rewardedAds: PLACEMENTS.rewardedAds,
    };
  }

  /** Alias kept short for controllers. */
  async getConfig(userId) {
    return this.config_(userId);
  }

  /**
   * Ad slot markers for one screen, to place between list items. Empty when ads are off for this user.
   * `count` is the number of items in the list the markers refer to.
   */
  async slotsFor(userId, screen, count) {
    const placement = PLACEMENTS.placements.find((p) => p.screen === screen && p.format === "native");
    if (!placement || count <= 0 || !(await this.enabledFor(userId))) return [];
    const unitId = this.units()[placement.unit];
    if (!unitId) return [];
    const slots = [];
    const { first, every } = placement.position;
    for (let at = first; at < count && slots.length < placement.maxPerSession; at += every) {
      slots.push({ placement: placement.key, after: placement.position.after, afterIndex: at - 1, adUnitId: unitId });
    }
    return slots;
  }
}
