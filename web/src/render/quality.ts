/**
 * Rendering quality tiers.
 *
 * The game ships one visual pipeline — bloom post-processing, full-resolution
 * rendering, a dense starfield and particle bursts — and it was only ever tuned
 * on a flagship phone (see the 60fps invariant in CLAUDE.md: "only the physical
 * S25 answers invariant 1.5"). A budget device cannot sustain 60fps under it.
 * The report that prompted this was a Xiaomi Redmi Note 14, a Mali-G57-class
 * GPU — visibly janky, not merely an audio-latency complaint.
 *
 * **There is no reliable *hardware* signal for a weak GPU on the web.** That
 * same Redmi reports 8 CPU cores and enough RAM to look like a flagship; the web
 * exposes nothing about the GPU itself. So the decision is made three ways, in
 * priority order:
 *
 *   1. A manual pin (`getQualitySetting`) — the player's choice always wins.
 *   2. A remembered auto-downgrade (`hasAutoLow`) — once the renderer has caught
 *      a device running slow, it stays low so the drop happens once, not every
 *      song.
 *   3. A conservative static guess (`detectQuality`) — only obviously low-end
 *      hardware, because a false `low` on a good phone is a worse game for no
 *      reason.
 *
 * The live frame-time downgrade that feeds (2) lives in the renderer
 * (`highway.ts`), which is the only place that knows how fast frames are
 * actually landing.
 */

export type QualityTier = 'high' | 'medium' | 'low';

/**
 * Ordered best-first. The live downgrade steps along this one rung at a time
 * rather than jumping to the bottom — see `nextTierDown`.
 */
export const QUALITY_TIERS: readonly QualityTier[] = ['high', 'medium', 'low'];

/** What the player chose. `auto` defers to the remembered/static detection. */
export type QualitySetting = 'auto' | QualityTier;

export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'high', 'medium', 'low'];

export const QUALITY_SETTING_LABELS: Record<QualitySetting, string> = {
  auto: 'Auto',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** The next rung down, or null at the bottom. */
export function nextTierDown(tier: QualityTier): QualityTier | null {
  return QUALITY_TIERS[QUALITY_TIERS.indexOf(tier) + 1] ?? null;
}

/**
 * The concrete knobs a tier turns. Pure data so the mapping is unit-tested and
 * the renderer just reads it — no quality `if`s scattered through construction.
 */
export interface QualityProfile {
  tier: QualityTier;
  /**
   * Bloom post-processing. The single most expensive effect: an `EffectComposer`
   * rendering the scene into a half-float target and running several full-screen
   * blur passes over it every frame. Off means the renderer draws straight to
   * the canvas — no offscreen target, no blur, no output copy.
   */
  bloom: boolean;
  /**
   * Linear scale on the bloom's own working resolution, per axis. 0.5 is a
   * quarter of the pixels through the whole five-level blur chain.
   *
   * This is the cheapest large win in the renderer, because bloom is a wide
   * low-frequency effect: it is a blur, so resolving it at full resolution
   * spends fill rate producing detail the blur immediately destroys. Halving
   * each axis is close to invisible and roughly quarters the cost of the most
   * expensive thing on screen.
   *
   * Ignored when `bloom` is false. `resize` must apply it *after*
   * `composer.setSize`, which resets every pass to the full canvas size.
   */
  bloomScale: number;
  /**
   * MSAA on the drawing buffer. Only matters when `bloom` is off, because that
   * is the path that renders straight to the canvas; with the composer the scene
   * goes to an offscreen target and this flag never touches it.
   */
  antialias: boolean;
  /**
   * Ceiling on `devicePixelRatio`. A 3x budget panel capped at 1 pushes a ninth
   * of the pixels — the biggest single fill-rate win on a weak GPU.
   */
  pixelRatioCap: number;
  /** Streaming starfield count. */
  starCount: number;
  /** Hit-burst particle pool size (also the draw range, so overdraw scales). */
  particleBudget: number;
  /** Light-streak trails behind the falling notes. */
  trails: boolean;
}

const HIGH: QualityProfile = {
  tier: 'high',
  bloom: true,
  // Half-resolution even at the top. The full-resolution chain was costing the
  // most expensive pass in the renderer for detail a blur throws away; nothing
  // about the look depends on it.
  bloomScale: 0.5,
  antialias: true,
  pixelRatioCap: 2,
  starCount: 560,
  particleBudget: 1500,
  trails: true,
};

/**
 * The rung that was missing.
 *
 * With only high and low, a phone that could not quite hold 60fps lost bloom,
 * antialiasing, note trails and two thirds of the starfield all at once — the
 * game's whole look, to buy headroom it may only have needed a fraction of.
 * Most phones belong here: bloom and trails survive (they carry the neon
 * identity), while the pixel-ratio cap and a quarter-resolution bloom do the
 * actual saving. Antialiasing is off because it never applied under bloom
 * anyway — the scene goes to an offscreen target on that path.
 */
const MEDIUM: QualityProfile = {
  tier: 'medium',
  bloom: true,
  bloomScale: 0.25,
  antialias: false,
  pixelRatioCap: 1.5,
  starCount: 360,
  particleBudget: 800,
  trails: true,
};

const LOW: QualityProfile = {
  tier: 'low',
  bloom: false,
  bloomScale: 1,
  antialias: false,
  pixelRatioCap: 1,
  starCount: 180,
  particleBudget: 400,
  trails: false,
};

const PROFILES: Record<QualityTier, QualityProfile> = {
  high: HIGH,
  medium: MEDIUM,
  low: LOW,
};

export function qualityProfile(tier: QualityTier): QualityProfile {
  return PROFILES[tier] ?? HIGH;
}

/**
 * A conservative up-front guess from the little the platform exposes.
 *
 * Deliberately only flags clearly low-end hardware — a false `low` on a capable
 * phone is a visibly poorer game for no reason. It will miss budget phones with
 * flagship-looking specs and a weak GPU (the Redmi is exactly this); those are
 * caught by the renderer's live frame-time downgrade instead.
 */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'high';

  // `deviceMemory` is GB, Chrome-only, and clamped to {0.25,0.5,1,2,4,8}. Only
  // 2GB-or-less is unambiguously low; 4GB is common on perfectly capable phones.
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem > 0 && mem <= 2) return 'low';

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) return 'low';

  return 'high';
}

const SETTING_KEY = 'tap-tap.quality';
const AUTO_LOW_KEY = 'tap-tap.quality.autoLow';

// Cached like the haptics mode: `resolveQuality` runs when a Highway is built,
// which is fine to read from storage, but caching keeps it cheap and consistent.
let cachedSetting: QualitySetting | null = null;

function isSetting(value: string | null): value is QualitySetting {
  return value !== null && (QUALITY_SETTINGS as readonly string[]).includes(value);
}

export function getQualitySetting(): QualitySetting {
  if (cachedSetting !== null) return cachedSetting;
  try {
    const stored = localStorage.getItem(SETTING_KEY);
    cachedSetting = isSetting(stored) ? stored : 'auto';
  } catch {
    cachedSetting = 'auto';
  }
  return cachedSetting;
}

/**
 * Persist the player's explicit choice. **Clears the remembered auto-downgrade**
 * (below): making any deliberate choice — including re-selecting `auto` — resets
 * the adaptive memory so the renderer probes the device afresh.
 */
export function setQualitySetting(setting: QualitySetting): void {
  cachedSetting = setting;
  try {
    localStorage.setItem(SETTING_KEY, setting);
    localStorage.removeItem(AUTO_LOW_KEY);
  } catch {
    // Private mode — the choice just will not persist.
  }
}

/** Next setting in the cycle, for a single-button toggle. */
export function nextQualitySetting(setting: QualitySetting): QualitySetting {
  return QUALITY_SETTINGS[(QUALITY_SETTINGS.indexOf(setting) + 1) % QUALITY_SETTINGS.length] ?? 'auto';
}

/**
 * The tier a previous session (or an earlier song this session) settled on after
 * catching this device running slow, or null if it never has. Persisted
 * separately from the explicit setting so the live downgrade is remembered
 * without overwriting — and silently masking — what the player actually chose.
 *
 * Stores a tier rather than the old boolean because the downgrade now steps
 * high → medium → low: a device that only needed one rung must not come back as
 * `low` next song. `'1'` is the value the boolean version wrote and still reads
 * as `low`, so an existing player's remembered downgrade survives the change.
 */
export function autoTier(): QualityTier | null {
  try {
    const stored = localStorage.getItem(AUTO_LOW_KEY);
    if (stored === '1') return 'low';
    return (QUALITY_TIERS as readonly string[]).includes(stored ?? '')
      ? (stored as QualityTier)
      : null;
  } catch {
    return null;
  }
}

/** Called by the renderer once it has decided the device cannot keep up. */
export function markAutoTier(tier: QualityTier): void {
  try {
    localStorage.setItem(AUTO_LOW_KEY, tier);
  } catch {
    // Private mode — it just will not be remembered next song.
  }
}

/**
 * The starting tier for a new Highway. A manual pin wins; failing that, a
 * remembered auto-downgrade; failing that, the static guess. When this returns
 * `high` under an `auto` setting the renderer may still drop it live.
 */
export function resolveQuality(): QualityTier {
  const setting = getQualitySetting();
  if (setting !== 'auto') return setting;
  return autoTier() ?? detectQuality();
}

/**
 * Whether the renderer is allowed to auto-downgrade on sustained slow frames.
 * Only under `auto`: a player who pinned `high` wants it kept, and one who
 * pinned `low` is already there.
 */
export function adaptiveAllowed(): boolean {
  return getQualitySetting() === 'auto';
}
