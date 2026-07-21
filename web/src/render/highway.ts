import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { NoteState } from '../game/engine.js';
import type { Tier } from '../game/judge.js';
import type { Theme } from '@tap-tap/shared';
import { DEFAULT_ACCENT } from '@tap-tap/shared';
import { laneColor } from './palette.js';

/**
 * Perspective note highway.
 *
 * Reads game state and draws it. Owns no rules: it is handed the notes to show
 * and the current song time, and decides nothing about hits, scoring, or timing.
 *
 * Note colours are pushed above 1.0 as they approach. Values over the bloom
 * threshold are what actually make them glow, so brightness is doing double
 * duty here: depth cue and light source.
 */

const LANE_WIDTH = 1.15;
/** Tap-tile footprint on the track, in world units. */
const TILE_WIDTH = LANE_WIDTH * 0.72;
/** Front-to-back length of a tile — its on-screen height. */
const TILE_DEPTH = 1.2;
/** The hit-zone frame now matches the tile footprint exactly (requested), so a tile drops dead-centre. */
const HIT_ZONE_DEPTH = TILE_DEPTH;
/** World-space distance from the spawn point to the hit line. */
const HIGHWAY_LENGTH = 18;

/**
 * How far the far end of the highway lifts, in world units.
 *
 * The track is not a flat plane: it bends upward with distance, so it reads as
 * a slope cresting away from the player and rolling down toward them. Notes
 * ride the same curve, which means they travel a visible arc down the screen
 * instead of a dead-straight line, and the far end compresses into a narrow
 * ribbon before the haze takes it.
 *
 * This is the one number to change if the curve feels wrong. Much past the
 * camera height (6.2) the far end rises to eye level and folds over on itself.
 */
const CURVE_HEIGHT = 0.5;

/**
 * Falloff of the lift. Must stay above 1 so the slope is still zero at the hit
 * line — that is what keeps the curve from meeting the receptors at a crease.
 *
 * Below 2 on purpose. A square puts most of its displacement in the last few
 * metres, which is precisely where the far fade swallows it: the curve is
 * mathematically large and visually absent. Pulling the exponent down moves the
 * bend into the mid-field, where the player is actually looking, and roughly
 * doubles the lift halfway down the track for the same height at the end.
 */
const CURVE_POWER = 1.6;

/** Vertical lift of the track surface at a given z. Flat at the hit line. */
function curveLift(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return CURVE_HEIGHT * Math.pow(t, CURVE_POWER);
}

/** d(lift)/dz — used to lay flat things (the note halos) along the slope. */
function curveSlope(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return (-CURVE_HEIGHT * CURVE_POWER * Math.pow(t, CURVE_POWER - 1)) / HIGHWAY_LENGTH;
}

/**
 * Fraction of full track width remaining at the far end.
 *
 * Perspective alone narrows the track, but not nearly enough once it curves
 * away — the far end stays a broad slab. Tapering the geometry on top of the
 * perspective sells the distance and gives the vanishing end the thin ribbon
 * look. Quadratic again, so the width is unchanged where the player is
 * actually aiming.
 */
const FAR_WIDTH = 0.42;

function curveWidth(z: number): number {
  const t = Math.min(1, Math.max(0, -z / HIGHWAY_LENGTH));
  return 1 - (1 - FAR_WIDTH) * t * t;
}
/**
 * The neon ground grid flanking the highway.
 *
 * The far end stops in front of the backdrop plane (z=-40), not past it: the
 * sky has `depthWrite: false` and so occludes nothing, and a ground plane
 * reaching behind it would be drawn on top of the sun.
 */
const GROUND_WIDTH = 170;
const GROUND_NEAR_Z = 12;
const GROUND_LENGTH = 48;

const MAX_NOTE_INSTANCES = 512;

/**
 * Hold bodies drawn at once.
 *
 * A pool of individual meshes rather than an `InstancedMesh`, because every
 * hold is a different length and instancing shares one geometry. Small on
 * purpose: only holds inside the approach window are ever on screen, and the
 * chart generator caps how many can overlap.
 */
const MAX_HOLD_BODIES = 24;

/** Where a hold's body starts and ends on the track, or null when it is off it. */
export interface HoldSpan {
  /** Nearest end, clamped at the hit line. */
  nearZ: number;
  /** Far end — the tail. */
  farZ: number;
}

/**
 * The z range a hold body should cover right now.
 *
 * Pure, and exported so it can be tested without a WebGL context — the same
 * split the rest of the project uses, where the geometry decision is logic and
 * only the vertex writing is rendering.
 *
 * **The near end is clamped at the hit line**, which is what makes a hold read
 * as being *consumed*: once its head arrives the body stops advancing and the
 * tail keeps coming, so the strip drains into the receptor while it is held.
 * Without the clamp the whole body would slide past the player like a long note
 * that had already been missed.
 */
export function holdSpan(
  noteT: number,
  duration: number,
  songTime: number,
  approachSec: number,
): HoldSpan | null {
  if (!(duration > 0)) return null;

  const zOf = (t: number): number => (-(t - songTime) / approachSec) * HIGHWAY_LENGTH;
  const farZ = zOf(noteT + duration);
  // Entirely behind the camera.
  if (farZ > 1) return null;

  const nearZ = Math.min(zOf(noteT), 0);
  // Fully consumed: the tail has reached the line too.
  if (nearZ <= farZ) return null;

  return { nearZ, farZ };
}

/**
 * Lengthwise segments in a hold body.
 *
 * **A hold has to be bent to the track and a plane cannot bend without
 * segments** — `PlaneGeometry(w, h)` is a single quad and stays flat however
 * its vertices are moved. The body also spans far more z than a note does, so
 * it needs enough divisions to follow `curveLift` smoothly rather than
 * chording across it.
 */
const HOLD_SEGMENTS = 24;
const MAX_PARTICLES = 1500;
/** Concurrent hit shockwaves. A short burst can stack a few across lanes. */
const MAX_SHOCKWAVES = 16;
const STAR_COUNT = 560;

/**
 * Camera rig. Height and distance set how steeply you look down the highway:
 * higher and closer tilts the view further over, which shows more of the lane
 * and makes note spacing easier to read.
 *
 * The height is per-style. The stage look uses a flatter, higher camera; the
 * classic synthwave look keeps its original 6.2, where its striped sun sits
 * framed on the horizon — the higher stage camera pushes that sun off the top.
 */
const CAMERA_HEIGHT = 7.5;
const CLASSIC_CAMERA_HEIGHT = 6.2;
const CAMERA_DISTANCE = 6.2;
const CAMERA_TARGET_Z = -9;
const BASE_FOV = 60;
/** Upper bound on widening; past this the perspective distortion is worse than the crop. */
const MAX_FOV = 96;

/**
 * Aspect below which the board counts as "portrait phone" and the hit line is
 * raised. Just under square, so tall phones qualify and landscape never does.
 */
const PORTRAIT_ASPECT = 0.85;
/** How far up the receptor line is nudged on a phone, as a fraction of viewport height. */
const HIT_RAISE_FRACTION = 0.13;

/** Stars stream from `STAR_FAR_Z` toward the camera and recycle past it. */
const STAR_FAR_Z = -130;
const STAR_RECYCLE_Z = 12;

/**
 * Fixed uniform-array length for the floor shader.
 *
 * GLSL array uniforms have a compile-time size, and three.js uploads exactly
 * as many elements as the declared length. Passing a shorter array (one entry
 * per actual lane) throws during the uniform upload and takes the whole render
 * loop down with it, so these are always padded to this length regardless of
 * how many lanes the chart uses.
 */
const MAX_SHADER_LANES = 8;

/**
 * A theme's sRGB hex as a linear `vec3` for a shader uniform.
 *
 * `THREE.Color` does the conversion because ColorManagement is on by default,
 * which is the same path the lane tints already take. Doing it here — rather
 * than storing linear values in the theme — is what lets a palette be picked in
 * an ordinary colour picker. Shader colours are linear; hex values are not, and
 * mixing the two up is how the ground grid first came out near-white.
 */
function skyColor(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export interface HighwayOptions {
  canvas: HTMLCanvasElement;
  laneCount: number;
  approachSec: number;
  /**
   * The song's palette. Resolve it with `themeFor(beatmap.themeId)` — that
   * never fails, which matters here because a theme that could not resolve
   * would throw in the constructor and leave a black screen rather than merely
   * the wrong colours.
   */
  theme: Theme;
  /** Beat times, used to pulse the scene in time with the music. */
  beatGrid?: readonly number[];
  /**
   * The song's cover image. Ringed at the vanishing point in `stage` style —
   * the reference's signature. Ignored by the classic look. Optional because a
   * song may have no thumbnail, in which case the ring is simply omitted.
   */
  coverUrl?: string;
}

export class Highway {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly laneCount: number;
  private readonly approachSec: number;
  private readonly theme: Theme;
  /** Beatstar-style rendering: dark colourless track, glowing rails, cover ring. */
  private readonly stage: boolean;
  /** The theme's bright accent — metal notes, rails, firework. */
  private readonly accent: number;
  /** Camera height, per style — the classic sun needs the lower original camera. */
  private readonly camHeight: number;
  private readonly beatGrid: readonly number[];
  private beatCursor = 0;

  /**
   * Pool of hold bodies, checked out per frame.
   *
   * Their geometry is rewritten in place each frame — a hold's on-screen length
   * changes continuously as it approaches and again as it is consumed — so these
   * are allocated once and mutated rather than rebuilt.
   */
  private readonly holdBodies: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];

  private readonly notes: THREE.InstancedMesh;
  /**
   * Soft additive pool under each note.
   *
   * Glow and core are deliberately separate meshes. Driving both from one
   * brightness value means the ramp straddles the bloom threshold: distant
   * notes fall under it and do not glow at all, while near ones blow past it
   * and clip to white, losing their silhouette exactly when the player needs
   * to read it. The halo carries the glow so the core can stay legible.
   */
  private readonly noteGlow: THREE.InstancedMesh;
  private readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly stars: THREE.Points;
  private readonly starPositions: Float32Array;
  /** Per-star travel speed, so the field parallaxes instead of moving as a sheet. */
  private readonly starSpeeds: Float32Array;

  private readonly pads: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  /** Rectangular hit-zone frames, one per lane. The target a tap tile lands in. */
  private readonly hitZones: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  /** The two bright glowing rails down the outer edges of the track. */
  private readonly rails: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  /** Radial spikes around the cover art — the audio-wave firework (stage only). */
  private readonly coverBars: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  /** Per-bar random phase so the ring shimmers instead of pulsing as one. */
  private readonly coverBarSeed: number[] = [];

  private readonly particles: THREE.Points;
  private readonly particlePositions: Float32Array;
  private readonly particleColors: Float32Array;
  private readonly particleVelocities: Float32Array;
  private readonly particleLife: Float32Array;
  private particleCursor = 0;

  /** Per-lane glow that decays each frame, driven by key presses and hits. */
  private readonly laneFlash: Float32Array;
  /** Camera kick on a hit, decaying back to rest. */
  private punch = 0;
  /** Screen-shake magnitude, decaying to rest. Bumped on a hit, scaled by combo. */
  private shake = 0;

  /** Expanding shockwave rings, one pool slot per concurrent hit. */
  private readonly shockwaves: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  /** 1 → 0 over a shockwave's life; 0 means the slot is free. */
  private readonly shockwaveLife = new Float32Array(MAX_SHOCKWAVES);
  private shockwaveCursor = 0;

  private readonly dummy = new THREE.Object3D();
  /** Scratch vector for projecting receptors during hit testing. */
  private readonly probe = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private disposed = false;

  constructor({ canvas, laneCount, approachSec, theme, beatGrid = [], coverUrl }: HighwayOptions) {
    this.laneCount = laneCount;
    this.approachSec = approachSec;
    // Assigned before any build* call: every one of them reads it, and a field
    // set after `buildBackdrop()` would be undefined at the moment it is needed.
    this.theme = theme;
    // Stage is the default look now; the classic synthwave sun is an explicit
    // opt-in that nothing ships with, so a theme is classic only if it says so.
    this.stage = theme.style !== 'classic';
    this.accent = theme.accent ?? DEFAULT_ACCENT;
    this.camHeight = this.stage ? CAMERA_HEIGHT : CLASSIC_CAMERA_HEIGHT;
    this.beatGrid = beatGrid;
    this.laneFlash = new Float32Array(laneCount);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    // Derived from the theme rather than a fixed near-black. The backdrop plane
    // covers the frustum in normal play, but it stops short at very wide aspect
    // ratios, and a violet sliver either side of an arctic sky reads as a bug.
    this.scene.background = new THREE.Color(theme.sky.below).multiplyScalar(0.4);

    // Lights exist ONLY for the note buttons — every other object uses an unlit
    // MeshBasicMaterial and ignores them, so the rest of the scene is unchanged.
    // A key light raking down from above-front lets the tiles' beveled edges
    // catch a real highlight and shade, which is what makes them read as solid
    // 3D metal; the ambient keeps the shadowed bevels from crushing to black.
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(0.25, 1, 0.5);
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    // The environment the metal notes reflect. Only MeshStandardMaterial reads
    // it (everything else is unlit/basic), so it costs nothing elsewhere. A warm
    // studio gradient with a bright overhead light band gives the gold a moving
    // reflection — the thing that actually makes it look like metal.
    this.scene.environment = Highway.makeEnvTexture();

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
    this.camera.position.set(0, this.camHeight, CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, CAMERA_TARGET_Z);

    this.backdrop = this.buildBackdrop();
    this.scene.add(this.backdrop);

    // The cover art ringed at the vanishing point — the reference's signature.
    // Stage style only, and only when the song actually has a thumbnail.
    if (this.stage && coverUrl) this.buildAlbumRing(coverUrl);

    this.starPositions = new Float32Array(STAR_COUNT * 3);
    this.starSpeeds = new Float32Array(STAR_COUNT);
    this.stars = this.buildStars();
    this.scene.add(this.stars);

    // Before the floor: the highway is translucent and has to composite over
    // the ground, not the other way round.
    this.ground = this.buildGround();
    this.scene.add(this.ground);

    this.floor = this.buildFloor();
    this.scene.add(this.floor);

    // Rails are a stage-style flourish; the classic synthwave look has none.
    if (this.stage) this.buildRails();

    this.buildReceptors();

    // Before the notes, so a hold's head pill draws over its own body rather
    // than being swallowed by it.
    this.buildHoldBodies();

    this.noteGlow = this.buildNoteGlow();
    this.scene.add(this.noteGlow);

    this.notes = this.buildNotes();
    this.scene.add(this.notes);

    this.particlePositions = new Float32Array(MAX_PARTICLES * 3);
    this.particleColors = new Float32Array(MAX_PARTICLES * 3);
    this.particleVelocities = new Float32Array(MAX_PARTICLES * 3);
    this.particleLife = new Float32Array(MAX_PARTICLES);
    this.particles = this.buildParticles();
    this.scene.add(this.particles);

    this.buildShockwaves();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Tight radius and a high threshold. A wide radius smears the hit line and
    // lit floor across the entire sky as a flat haze, which reads as a washed
    // out background rather than as glow.
    // Radius 0 and a low strength: a wide, strong bloom smears every bright edge
    // into a soft haze that reads as the whole scene being out of focus. Keep it
    // to a faint flare so the notes, rails and glow stay crisp.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.0, 0.85);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());
  }

  // --- construction --------------------------------------------------------

  private get halfWidth(): number {
    return (this.laneCount * LANE_WIDTH) / 2;
  }

  private laneX(lane: number): number {
    return (lane - (this.laneCount - 1) / 2) * LANE_WIDTH;
  }

  /** A note's tile colour: the theme's accent in `stage` style, the lane hue otherwise. */
  private noteHex(lane: number): number {
    return this.stage ? this.accent : laneColor(this.theme, lane);
  }

  private buildBackdrop(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    // The classic synthwave sky: a striped sun setting on the horizon over a
    // graded backdrop. Statements only — the shared header below declares the
    // uniforms, helpers and consts it uses.
    const classicMain = /* glsl */ `
          // The sky colours arrive as LINEAR uniforms — THREE.Color converted
          // them from the theme's sRGB hex. ACES tone mapping plus the sRGB
          // transfer curve lifts midtones hard, so a theme whose sky reads as a
          // reasonable hex still has to be a *dark* hex: linear 0.14 lands near
          // sRGB 0.42 on screen.
          //
          // Everything below is deliberately dim. This is a backdrop: the notes
          // and the hit line have to stay the brightest things on screen, so
          // nothing here may cross the bloom threshold (0.8) and start glowing
          // in competition with them.
          float sky = smoothstep(HORIZON, 0.545, vUv.y);

          vec3 horizonCol = mix(uSkyHorizon, uSkyHorizonAlt, 0.3 + uTreble * 0.3);
          vec3 base = mix(horizonCol, uSkyTop, sky);

          // Below eye level the backdrop only peeks past the edges of the
          // track, so it drops away to near-black rather than competing.
          base = mix(base, uSkyBelow, smoothstep(HORIZON, HORIZON - 0.08, vUv.y));

          // --- sun --- anchored in world space, not guessed in uv. The disc
          // beats with the track: uPulse swells and flares it on the downbeat.
          float sunR = SUN_R * (1.0 + uPulse * 0.06);
          vec2 sunOffset = vec2((vUv.x - 0.5) * PLANE_ASPECT, vUv.y - SUN_Y);
          float sunDist = length(sunOffset);
          float sunMask = smoothstep(sunR, sunR - 0.004, sunDist);

          // 0 at the crown, 1 at the waterline.
          float depth = clamp((SUN_Y + SUN_R - vUv.y) / (2.0 * SUN_R), 0.0, 1.0);

          // Horizontal slits, the retrowave signature. Gaps widen toward the
          // bottom so the disc dissolves into the haze, crown stays solid.
          float slitPhase = fract(vUv.y * 150.0);
          float gap = mix(0.10, 0.66, depth);
          sunMask *= mix(1.0, step(gap, slitPhase), smoothstep(0.12, 0.5, depth));

          vec3 sunCol = mix(uSun, uSunCrown, smoothstep(HORIZON, SUN_Y + SUN_R, vUv.y));
          sunCol *= 1.0 + uPulse * 0.5;
          // Cut flat at the horizon so the sun sets behind the world.
          sunMask *= step(HORIZON, vUv.y);
          base = mix(base, sunCol, sunMask);

          // Atmospheric bloom around the disc, swelling with the beat.
          base += uHaze * smoothstep(SUN_R * 2.6, SUN_R * 0.9, sunDist) * (0.5 + uPulse * 0.55);

          // Drifting nebula, kept subtle: it is texture, not a light source.
          float n = noise(vUv * vec2(5.0, 3.0) + vec2(uTime * 0.03, uTime * 0.015));
          n *= noise(vUv * vec2(11.0, 7.0) - vec2(uTime * 0.02, 0.0));
          base += uGlow * 0.34 * n * (0.05 + uTreble * 0.14) * sky;

          // Haze hugging the horizon.
          base += uHaze * 0.34 * smoothstep(0.022, 0.0, abs(vUv.y - HORIZON)) * 0.40;

          // Glow at the vanishing point, swelling on the low end and each beat.
          float d = distance(vUv, vec2(0.5, 0.44));
          float glow = smoothstep(0.20, 0.0, d) * (0.03 + uBass * 0.18 + uPulse * 0.10);
          base += uGlow * glow;

          gl_FragColor = vec4(base, 1.0);
    `;

    // The Beatstar-style dark stage: near-black lit only by a warm lamp pooled
    // behind the vanishing point. See the note below on why the glow is a thin
    // horizontal band rather than a disc.
    const stageMain = /* glsl */ `
          // The scene is near-black. The only real light is a warm bloom pooled
          // behind the track's vanishing point — a stage lamp, not a setting
          // sun. Colours arrive as LINEAR uniforms, so the multipliers are tiny:
          // ACES + sRGB lift midtones hard. The glow is the one place the
          // background may approach the bloom threshold, because it sits behind
          // the horizon where no notes are; everything else stays dim.

          // The visible slice of this plane is only ~0.1 of vUv.y tall (measured,
          // not derived — the camera squashes the sky into a sliver), so the
          // glow's vertical reach must be tiny or it washes the whole frame.
          // Hence the large vertical multiplier: it pools the light into a thin
          // horizontal band at the horizon.
          float GLOW_Y = 0.45;
          float GLOW_R = 0.30;

          vec3 base = uSkyBelow * 0.06;

          vec2 g = vec2((vUv.x - 0.5) * 1.0, (vUv.y - GLOW_Y) * 4.2);
          float d = length(g);
          float glow = pow(smoothstep(GLOW_R, 0.0, d), 1.7);
          float beat = 0.4 + uBass * 0.4 + uPulse * 0.5;
          base += uSun * glow * beat;

          // A hotter core that crosses the bloom threshold, so the centre of the
          // stage blooms like a lamp behind the horizon.
          float core = pow(smoothstep(GLOW_R * 0.42, 0.0, d), 2.0);
          base += uSunCrown * core * (0.7 + uPulse * 0.5);

          // Faint drifting haze inside the glow, so the light has texture.
          float n = noise(vUv * vec2(6.0, 3.5) + vec2(uTime * 0.03, uTime * 0.015));
          base += uGlow * n * glow * (0.05 + uTreble * 0.10);

          gl_FragColor = vec4(base, 1.0);
    `;

    const material = new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uPulse: { value: 0 },
        // THREE.Color linearizes sRGB hex on the way in (ColorManagement is on
        // by default), which is exactly what the shader wants — these used to be
        // hand-written linear literals. Converting here rather than storing
        // linear values in the theme means a palette can be picked in a normal
        // colour picker; see the note on SkyPalette.
        uSkyTop: { value: skyColor(this.theme.sky.top) },
        uSkyHorizon: { value: skyColor(this.theme.sky.horizon) },
        uSkyHorizonAlt: { value: skyColor(this.theme.sky.horizonAlt) },
        uSkyBelow: { value: skyColor(this.theme.sky.below) },
        uSun: { value: skyColor(this.theme.sky.sun) },
        uSunCrown: { value: skyColor(this.theme.sky.sunCrown) },
        uHaze: { value: skyColor(this.theme.sky.haze) },
        uGlow: { value: skyColor(this.theme.sky.glow) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uBass;
        uniform float uTreble;
        uniform float uPulse;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyHorizonAlt;
        uniform vec3 uSkyBelow;
        uniform vec3 uSun;
        uniform vec3 uSunCrown;
        uniform vec3 uHaze;
        uniform vec3 uGlow;

        // Cheap value noise, enough for a soft nebula.
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
        }


        /**
         * Eye level, and therefore the on-screen horizon.
         *
         * Measured, not derived: a temporary debug stripe every 0.05 of vUv.y
         * showed the visible band is only about 0.19 to 0.53, with the horizon
         * at 0.485 — right at the top. There is only ~95px of sky above the
         * track.
         *
         * Anything sized from the plane's 200x120 dimensions instead of this
         * number comes out enormous: a sun radius that looked small in uv terms
         * filled the whole frame on the first attempt.
         */
        const float HORIZON = 0.414;

        /** Plane is 200x120, so x must be scaled to measure a round sun. */
        const float PLANE_ASPECT = 200.0 / 120.0;
        /** Just above the horizon line, so the disc reads as half-set. Lowered
         * from 0.446 and shrunk so the crown clears the top of the frame under
         * the current (shorter, flatter) track framing instead of being cut. */
        const float SUN_Y = 0.428;
        /** ~7.4 world units. Roughly the sky's height above the horizon. */
        const float SUN_R = 0.05;


        void main() {
          ${this.stage ? stageMain : classicMain}
        }
      `,
    });

    // Sized to overshoot the frustum in every direction: a visible plane edge
    // reads as a hard seam across the sky.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 120), material);
    // Classic sits at its original -40 (where its sun was tuned to frame on the
    // horizon, back when the track was longer); stage tucks the plane closer so
    // its glow band and cover ring sit right behind the shorter track.
    mesh.position.set(0, 8, this.stage ? -HIGHWAY_LENGTH - 14 : -40);
    mesh.renderOrder = -2;
    return mesh;
  }

  /**
   * The song's cover art, ringed and standing at the vanishing point — the one
   * element that most makes the reference read as itself. A disc textured with
   * the thumbnail, a bright warm ring around it, tilted to face the player and
   * sitting just in front of the backdrop so the glow haloes it.
   *
   * The texture loads asynchronously; the meshes are built now and simply show
   * black until it arrives. Loaded through the same origin the menu thumbnails
   * use, so there is no CORS taint on the canvas.
   */
  private buildAlbumRing(coverUrl: string): void {
    const RADIUS = 2.5;
    // Standing just past the track's far end, on the horizon glow. Lowered and
    // shrunk so the whole disc (and its ring of spikes) clears the top HUD
    // instead of being cropped by the frame edge.
    const center = new THREE.Vector3(0, 2.9, -HIGHWAY_LENGTH - 4);
    const tilt = -0.15;

    const texture = new THREE.TextureLoader().load(coverUrl);
    texture.colorSpace = THREE.SRGBColorSpace;

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS, 64),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, fog: false }),
    );
    disc.position.copy(center);
    disc.rotation.x = tilt;
    // In front of the backdrop, behind everything on the track.
    disc.renderOrder = -1;
    this.scene.add(disc);

    // A thin bright rim. Was 12% of the radius thick and additive — a fat glowing
    // band. A slim ring at moderate opacity reads as a crisp edge, not a halo.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(RADIUS * 1.0, RADIUS * 1.035, 96),
      new THREE.MeshBasicMaterial({
        color: this.accent,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    );
    ring.position.copy(center);
    ring.rotation.x = tilt;
    ring.renderOrder = -1;
    this.scene.add(ring);

    this.buildCoverWave(center, tilt, RADIUS);
  }

  /**
   * A ring of radial spikes around the cover art, driven by the live audio
   * spectrum — the "firework" around the CD. Each spike lies in the disc's tilted
   * plane and grows outward with its frequency band, flaring on the beat. Built
   * as a pool of thin additive quads with their pivot at the inner end, so a
   * per-frame scale on the length axis is all it takes to animate them.
   */
  private buildCoverWave(center: THREE.Vector3, tilt: number, radius: number): void {
    const COUNT = 96;
    const group = new THREE.Group();
    group.position.copy(center);
    group.rotation.x = tilt;

    for (let i = 0; i < COUNT; i++) {
      const angle = (i / COUNT) * Math.PI * 2;

      // A thin quad whose pivot is its inner (bottom) end, so scaling Y grows it
      // straight outward from the ring rather than from its middle.
      const geometry = new THREE.PlaneGeometry(0.045, 1);
      geometry.translate(0, 0.5, 0);

      const bar = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: this.accent,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      // Point local +Y radially outward at this angle, seated just outside the rim.
      bar.rotation.z = angle - Math.PI / 2;
      bar.position.set(Math.cos(angle) * radius * 1.06, Math.sin(angle) * radius * 1.06, 0);
      bar.scale.y = 0.001;

      this.coverBars.push(bar);
      this.coverBarSeed.push(Math.random() * Math.PI * 2);
      group.add(bar);
    }

    group.renderOrder = -1;
    this.scene.add(group);
  }

  private updateCoverWave(songTime: number, pulse: number, spectrum?: Uint8Array): void {
    if (this.coverBars.length === 0) return;

    const count = this.coverBars.length;
    // The buffer is 512 but the analyser only fills its 256 real bins; the rest
    // stay zero, so cap here or the treble half of the ring reads dead.
    const bins = spectrum ? Math.min(spectrum.length, 256) : 0;
    for (let i = 0; i < count; i++) {
      const bar = this.coverBars[i]!;

      // Map the ring symmetrically onto the spectrum: both sides sweep bass→treble
      // from the bottom of the circle up, so the firework is mirrored left/right.
      const half = i < count / 2 ? i : count - 1 - i;
      const frac = half / (count / 2);
      let level = 0;
      if (bins > 0) {
        // Skip the lowest couple of bins (DC/rumble); ride the low-mid range where
        // the energy is. Byte spectrum is 0..255.
        const bin = 2 + Math.floor(frac * (bins * 0.55));
        level = (spectrum![Math.min(bin, bins - 1)] ?? 0) / 255;
      }

      // A gentle idle shimmer so the ring lives even in quiet passages, plus a
      // beat flare that shoots the spikes out on the downbeat.
      const shimmer = 0.5 + 0.5 * Math.sin(songTime * 5 + this.coverBarSeed[i]!);
      const length = 0.08 + level * 1.1 + pulse * 0.25 + shimmer * 0.06;

      bar.scale.y = length;
      (bar.material as THREE.MeshBasicMaterial).opacity = 0.35 + level * 0.6 + pulse * 0.2;
    }
  }

  /**
   * Soft round sprite for point clouds. Without it `THREE.Points` renders each
   * point as a hard square, which reads as blocky debris rather than as stars
   * or sparks — very obvious once points get large near the camera.
   */
  private static makeDotTexture(): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.35, 'rgba(255,255,255,0.75)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }

    return new THREE.CanvasTexture(canvas);
  }

  /**
   * A hollow rounded-rectangle frame for the hit zones — transparent inside, a
   * bright rim, so the receptor reads as a target a tile drops into rather than
   * a filled pad. Matches `makeTileTexture` so tile and target share a shape.
   */
  private static makeFrameTexture(aspect: number): THREE.CanvasTexture {
    // Matches the tile footprint and its rounding, so a bar drops into a slot of
    // the same rounded shape. Aspect-driven like the tile so corners stay round.
    const w = 256;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      const inset = Math.round(w * 0.1);
      const r = Math.round((w - inset * 2) * 0.14);
      Highway.roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, r);
      ctx.lineWidth = 18;
      ctx.strokeStyle = 'rgba(255,255,255,1)';
      ctx.stroke();
      // A faint inner wash so an empty lane still reads as a slot, not a gap.
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    return texture;
  }

  /** Rounded-rect path helper; `roundRect` is not in every target's 2D context. */
  private static roundRectPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Randomize a star's lateral position. Depth is set by the caller. */
  private placeStar(i: number): void {
    // Spread wide enough that stars pass to the sides and overhead rather than
    // all converging on the vanishing point.
    this.starPositions[i * 3] = (Math.random() - 0.5) * 120;
    this.starPositions[i * 3 + 1] = Math.random() * 52 - 10;
  }

  private buildStars(): THREE.Points {
    const colors = new Float32Array(STAR_COUNT * 3);
    const tint = new THREE.Color();

    for (let i = 0; i < STAR_COUNT; i++) {
      this.placeStar(i);
      // Seed depth across the whole corridor so the field starts full rather
      // than arriving as one wave.
      this.starPositions[i * 3 + 2] = STAR_FAR_Z + Math.random() * (STAR_RECYCLE_Z - STAR_FAR_Z);
      this.starSpeeds[i] = 7 + Math.random() * 17;

      tint.setHSL(0.55 + Math.random() * 0.28, 0.75, 0.55 + Math.random() * 0.3);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.starPositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        // Small on purpose. With size attenuation the near ones swell as they
        // pass the camera, so anything much larger reads as blobs drifting over
        // the track rather than as distant stars.
        size: 0.22,
        map: Highway.makeDotTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        // Size attenuation is what sells the depth: stars swell as they pass.
        sizeAttenuation: true,
      }),
    );
    points.renderOrder = -1;
    points.frustumCulled = false;
    return points;
  }

  /** Fly the starfield toward the camera, recycling stars once they pass. */
  private updateStars(dt: number, bass: number): void {
    const boost = 1 + bass * 2.4;

    for (let i = 0; i < STAR_COUNT; i++) {
      const zi = i * 3 + 2;
      const z = (this.starPositions[zi] ?? 0) + (this.starSpeeds[i] ?? 0) * boost * dt;

      if (z > STAR_RECYCLE_Z) {
        this.placeStar(i);
        this.starPositions[zi] = STAR_FAR_Z + Math.random() * 10;
      } else {
        this.starPositions[zi] = z;
      }
    }

    this.stars.geometry.attributes['position']!.needsUpdate = true;
  }

  /**
   * The neon grid the highway stands on.
   *
   * The signature of the whole look, and the piece that was missing: without it
   * the track floats in black space, while the menu behind it has a full grid
   * floor. This is what makes the game and the shell read as one place.
   *
   * Three things keep it from becoming noise:
   *
   *  - It is **cut out under the highway**. The floor is translucent, so grid
   *    lines would otherwise run straight through the lanes and cross the notes
   *    the player is trying to read.
   *  - It **stops short of the backdrop**. The sky plane sits at z=-40 with
   *    `depthWrite: false`, so it cannot occlude anything; a ground plane
   *    running past it would draw *over* the sky. This one fades to nothing
   *    well before it gets there and dissolves into the horizon haze.
   *  - It is held far below the bloom threshold. Anything that glows here
   *    competes with the notes.
   */
  private buildGround(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uScroll: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        // How much of the middle to keep clear for the track. Widened past the
        // real half-width so the cut lands outside the lane tints rather than
        // exactly on their edge, where it would read as a seam.
        uClear: { value: this.halfWidth + 1.2 },
        // The ground echoes the first two lane colours rather than carrying its
        // own pair. That keeps a theme coherent for free — the scenery is
        // visibly made of the same neon as the track — and for the default
        // theme it lands on the pink/cyan these lines were hardcoded to.
        uGridA: { value: skyColor(laneColor(this.theme, 0)) },
        uGridB: { value: skyColor(laneColor(this.theme, 1)) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uScroll;
        uniform float uBass;
        uniform float uPulse;
        uniform float uClear;
        uniform vec3 uGridA;
        uniform vec3 uGridB;

        const float WIDTH = ${GROUND_WIDTH.toFixed(1)};
        const float LENGTH = ${GROUND_LENGTH.toFixed(1)};
        /**
         * World units between grid lines.
         *
         * Read against the lane width (1.15), not in the abstract: at 4.0 a
         * single grid cell was wider than three lanes, which made the floor look
         * like a scaled-up version of a different scene sitting behind the
         * track. Roughly one lane per cell puts the floor at the same scale as
         * the thing standing on it.
         */
        const float SPACING = 1.1;

        /*
         * Lines widen with distance instead of using fwidth().
         *
         * A constant world-space width aliases into a shimmering mess at the far
         * end, where many lines fall inside one pixel. Widening them keeps each
         * line at roughly a constant size on screen, which is what a real
         * receding grid looks like anyway.
         */
        float gridLine(float coord, float halfWidth) {
          float d = abs(fract(coord / SPACING - 0.5) - 0.5) * SPACING;
          return smoothstep(halfWidth, 0.0, d);
        }

        void main() {
          float worldX = (vUv.x - 0.5) * WIDTH;
          float along = vUv.y * LENGTH;
          // Scales with SPACING: keeping the old widths against a denser grid
          // fattens the lines until the gaps between them close up.
          float lineW = mix(0.028, 0.34, vUv.y);

          // Pink runs away from the player, cyan across — the same split as the
          // menu's CSS grid, so the two backgrounds agree.
          float lengthwise = gridLine(worldX, lineW);
          float crosswise = gridLine(along + uScroll, lineW);

          // These are LINEAR and therefore much lower than they look. ACES plus
          // the sRGB curve lifts midtones hard; the first pass at 0.42 pink came
          // out near-white and buried the lanes.
          // The scalars are the tuning, not the colours. Lane hues arrive at
          // full brightness — they are meant to be the brightest things on
          // screen — and the ground is scenery that must lose to the notes.
          // The first pass at this grid used linear 0.42 pink and came out
          // near-white, burying the lanes it was supposed to frame.
          vec3 col = uGridA * 0.15 * lengthwise
                   + uGridB * 0.11 * crosswise;

          float grid = max(lengthwise, crosswise);

          // Clear the track. Feathered, not a hard edge.
          float clear = smoothstep(uClear - 1.4, uClear + 0.6, abs(worldX));

          // Dissolve into the horizon haze rather than ending at the plane's
          // edge, and pull the very near foreground down so the grid does not
          // crowd the receptors.
          float farFade = smoothstep(1.0, 0.55, vUv.y);
          // The near foreground fades over a long run, not a token one: the
          // closest lines are metres wide on screen and sit right beside the
          // receptors, which is the last place anything should pull the eye.
          float nearFade = smoothstep(0.0, 0.22, vUv.y);
          // Sides fall away too, so the plane's left and right edges never show.
          float sideFade = smoothstep(0.5, 0.24, abs(vUv.x - 0.5));

          // On the dark stage the grid is only a faint hint of a floor; in the
          // classic synthwave look it is the signature neon and stays bright.
          float alpha = grid * clear * farFade * nearFade * sideFade
                      * (${this.stage ? '0.08 + uBass * 0.06 + uPulse * 0.04' : '0.34 + uBass * 0.20 + uPulse * 0.10'});

          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const geometry = new THREE.PlaneGeometry(GROUND_WIDTH, GROUND_LENGTH, 1, 120);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    // Below the highway floor (-0.12) by enough to never z-fight with it.
    mesh.position.set(0, -0.34, GROUND_NEAR_Z - GROUND_LENGTH / 2);

    // Same lift as the track, so the highway stays sitting on the ground as it
    // climbs. Deliberately NOT `bendToCurve`: that also applies `curveWidth`,
    // which tapers the track — pulling the ground's far edges inward with it
    // would leave the sky showing through wedges either side of the horizon.
    const position = geometry.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      // See bendToCurve: rotation.x = -PI/2 maps local +Y to world -Z and local
      // +Z to world +Y, so lift is written into local Z.
      position.setZ(i, curveLift(mesh.position.z - position.getY(i)));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    mesh.renderOrder = -1;
    return mesh;
  }

  private buildFloor(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    // Feed the lane tints in as a uniform so the floor is coloured per lane
    // rather than a single flat purple.
    const laneTints: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_SHADER_LANES; i++) {
      if (i < this.laneCount) {
        const c = new THREE.Color(laneColor(this.theme, i));
        laneTints.push(new THREE.Vector3(c.r, c.g, c.b));
      } else {
        laneTints.push(new THREE.Vector3(0, 0, 0)); // padding, never sampled
      }
    }

    const material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uBass: { value: 0 },
        uPulse: { value: 0 },
        uLaneCount: { value: this.laneCount },
        uLaneTints: { value: laneTints },
        uLaneFlash: { value: new Float32Array(MAX_SHADER_LANES) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #define MAX_LANES ${MAX_SHADER_LANES}
        varying vec2 vUv;
        uniform float uTime;
        uniform float uScroll;
        uniform float uBass;
        uniform float uPulse;
        uniform float uLaneCount;
        uniform vec3 uLaneTints[MAX_LANES];
        uniform float uLaneFlash[MAX_LANES];

        void main() {
          float lanePos = vUv.x * uLaneCount;
          int laneIndex = int(clamp(floor(lanePos), 0.0, uLaneCount - 1.0));
          vec3 tint = uLaneTints[laneIndex];
          float flash = uLaneFlash[laneIndex];

          // Lane separators.
          float laneEdge = abs(fract(lanePos) - 0.5);
          float separator = smoothstep(0.5, 0.46, laneEdge);

          // Rungs scrolling toward the player.
          float rung = fract(vUv.y * 16.0 + uScroll);
          float rungs = smoothstep(0.90, 1.0, rung) * 0.30;

          // Each lane carries its own colour, brightest near the hit line. Kept
          // dim on purpose: the floor is a stage, and the notes are the subject.
          float nearGlow = pow(1.0 - vUv.y, 3.6);
          // In stage style the track is near-black — the lane hue lives almost
          // entirely in the hit flash below — so the ambient body is a whisper.
          float laneBody = nearGlow * (${this.stage ? '0.03 + uBass * 0.05 + uPulse * 0.03' : '0.14 + uBass * 0.22 + uPulse * 0.08'});

          // A press lights the whole lane, not just the near end. The constant
          // term is what carries the highlight all the way up the highway;
          // without it the flash collapses into the hit line and reads as a
          // separate object rather than as "this lane".
          float flashGlow = flash * (0.34 + nearGlow * 0.85);

          // Stage keeps the track colourless — a neutral grey ambient and grey
          // separators — so the lane hue appears only in the flash on a hit.
          // Classic tints the whole lane as before.
          vec3 ambient = ${this.stage ? 'vec3(0.7)' : 'tint'};
          vec3 rungCol = ${this.stage ? 'vec3(0.7)' : 'vec3(0.55, 0.75, 1.0)'};
          vec3 col = ambient * laneBody
                   + tint * flashGlow
                   + ambient * separator * 0.22
                   + rungCol * rungs * 0.28;

          // Dissolve the far end instead of stopping at a hard edge, so the
          // highway reads as receding into the distance rather than being cut.
          float farFade = smoothstep(1.0, 0.62, vUv.y);

          float alpha = clamp(laneBody * 1.4 + separator * 0.42 + rungs * 0.8 + flashGlow * 1.1, 0.0, 1.0)
                      * 0.62 * farFade;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    // Segmented along its length so it can actually bend — a single quad would
    // stay flat no matter what the vertices say.
    const geometry = new THREE.PlaneGeometry(this.halfWidth * 2, HIGHWAY_LENGTH + 6, 1, 96);
    const mesh = new THREE.Mesh(geometry, material);
    // `rotation.x = -PI/2` alone already puts v=0 at the near edge (the hit
    // line) and leaves u running left-to-right. An extra `rotation.z = PI` was
    // here to "flip v", but rotating about Z mirrors BOTH axes — which silently
    // reversed u and drew every lane's floor tint under the wrong lane.
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, -0.12, -(HIGHWAY_LENGTH + 6) / 2 + 3);
    Highway.bendToCurve(geometry, mesh.position.z);
    return mesh;
  }

  /**
   * Push the floor's vertices onto the curve.
   *
   * Done in the geometry's local space, before the mesh rotation is applied.
   * That `rotation.x = -PI/2` maps local +Y onto world -Z and local +Z onto
   * world +Y, so the vertical lift is written into local Z, and a vertex's
   * world z is `meshZ - localY`. Getting that mapping backwards tips the track
   * sideways rather than bending it, which looks like a bug in the camera.
   */
  private static bendToCurve(geometry: THREE.PlaneGeometry, meshZ: number): void {
    const position = geometry.attributes['position'] as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const worldZ = meshZ - position.getY(i);
      position.setZ(i, curveLift(worldZ));
      // Local X is the width axis and survives the mesh rotation untouched.
      // Scaling it here rather than in the shader keeps the UVs intact, so the
      // lane tints and beat rungs taper along with the geometry for free.
      position.setX(i, position.getX(i) * curveWidth(worldZ));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  /**
   * The two bright rails running down the outer edges of the track — the
   * signature of the reference look. Each is a thin strip lying on the track
   * surface, bent onto the curve and tapered inward with it, glowing hot enough
   * to cross the bloom threshold so it reads as a light strip, not a painted
   * line. Tinted by the theme's warm sun colour so it matches the stage glow.
   */
  private buildRails(): void {
    const RAIL_WIDTH = 0.14;
    const railColor = new THREE.Color(this.accent);

    for (const side of [-1, 1] as const) {
      const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Vector3(railColor.r, railColor.g, railColor.b) },
          uBass: { value: 0 },
          uPulse: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vUv;
          uniform vec3 uColor;
          uniform float uBass;
          uniform float uPulse;
          void main() {
            // Bright core across the strip's width, feathering to nothing at the
            // edges so it reads as a glowing tube rather than a hard band.
            float cross = pow(smoothstep(0.5, 0.0, abs(vUv.x - 0.5)), 1.6);
            // Dissolve into the horizon glow at the far end, and pull the very
            // near tip down so it doesn't stack on the receptor.
            float farFade = smoothstep(1.0, 0.55, vUv.y);
            float nearFade = smoothstep(0.0, 0.04, vUv.y);
            // Pushed well past the bloom threshold so the rail actually blooms;
            // it breathes with the low end and flares on the downbeat.
            float bright = 1.7 + uBass * 1.2 + uPulse * 1.4;
            vec3 col = uColor * bright * cross;
            float alpha = cross * farFade * nearFade;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      material.toneMapped = false;

      // Long and thin, segmented so it can bend along the curve.
      const geometry = new THREE.PlaneGeometry(RAIL_WIDTH, HIGHWAY_LENGTH, 1, 96);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      // Just above the floor (-0.12) so it sits on the surface, not through it.
      const meshZ = -HIGHWAY_LENGTH / 2;
      mesh.position.set(0, -0.04, meshZ);

      // Bend onto the curve and ride the outer edge. Same local-space mapping as
      // bendToCurve: rotation.x = -PI/2 writes lift into local Z, and a vertex's
      // world z is meshZ - localY. The edge itself tapers with curveWidth, so the
      // rail follows the narrowing track instead of hanging off it.
      const position = geometry.attributes['position'] as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const worldZ = meshZ - position.getY(i);
        const w = curveWidth(worldZ);
        position.setZ(i, curveLift(worldZ));
        position.setX(i, side * this.halfWidth * w + position.getX(i) * w);
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();

      mesh.renderOrder = 1;
      this.rails.push(mesh);
      this.scene.add(mesh);
    }
  }

  private buildReceptors(): void {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const hex = laneColor(this.theme, lane);

      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(LANE_WIDTH * 0.96, 1.35),
        new THREE.MeshBasicMaterial({
          // Stage receptors are dark warm slabs, not glowing colour: the colour
          // arrives only when the lane is struck.
          color: this.stage ? 0x2a251d : hex,
          transparent: true,
          opacity: this.stage ? 0.42 : 0.18,
          toneMapped: false,
        }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(this.laneX(lane), -0.07, 0);
      this.pads.push(pad);
      this.scene.add(pad);

      // A lit rectangular frame the same shape as a tap tile, so a tile visibly
      // drops *into* its target. Replaces the old ring — the receptors are the
      // one thing the player's eye rests on, so the shape has to match the notes.
      const frame = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: Highway.makeFrameTexture(HIT_ZONE_DEPTH / TILE_WIDTH),
          // A neutral warm outline in stage style — the reference's rounded pad
          // border — versus the lane-coloured frame of the classic look.
          color: this.stage ? 0xf2e6ca : hex,
          transparent: true,
          opacity: this.stage ? 0.42 : 0.6,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      frame.rotation.x = -Math.PI / 2;
      frame.position.set(this.laneX(lane), -0.05, 0);
      // Exactly the tile footprint (requested): the target is the same rectangle
      // as the bar that drops into it.
      frame.scale.set(TILE_WIDTH, 1, TILE_DEPTH);
      this.hitZones.push(frame);
      this.scene.add(frame);

      // The bright dash across each receptor — the crisp timing marker the
      // reference puts in the middle of every pad. Stage style only; the classic
      // look reads its timing off the coloured frame.
      if (this.stage) {
        const dash = new THREE.Mesh(
          new THREE.PlaneGeometry(LANE_WIDTH * 0.4, 0.13),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(this.laneX(lane), -0.03, 0);
        this.scene.add(dash);
      }
    }
  }

  private buildHoldBodies(): void {
    for (let i = 0; i < MAX_HOLD_BODIES; i++) {
      // 1 x 1 in local space, rebuilt every frame by `layoutHoldBody`. The
      // segment count is what lets it bend; the dimensions here are arbitrary.
      const geometry = new THREE.PlaneGeometry(1, 1, 1, HOLD_SEGMENTS);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          transparent: true,
          // Additive, like the halos: a hold body is light on the track, and
          // over-writing the lane tint underneath would flatten the highway.
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
          // Fog would eat the far end of a long body, which is exactly the part
          // that needs to read as "this continues".
          fog: false,
        }),
      );
      mesh.visible = false;
      // Behind the notes, in front of the floor.
      mesh.renderOrder = 1;
      this.holdBodies.push(mesh);
      this.scene.add(mesh);
    }
  }

  /**
   * Lay a body's vertices along the track between two z values.
   *
   * Written in world space directly rather than by positioning and rotating the
   * mesh, because the strip is *curved* — there is no single transform that
   * puts a flat quad on a bending surface. Each row of vertices gets its own
   * `curveLift` and `curveWidth`, which is the same treatment the floor and the
   * notes get and the reason they stay visually attached.
   */
  private layoutHoldBody(
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    lane: number,
    nearZ: number,
    farZ: number,
  ): void {
    const position = mesh.geometry.attributes['position'] as THREE.BufferAttribute;
    const rows = HOLD_SEGMENTS + 1;

    for (let row = 0; row < rows; row++) {
      // PlaneGeometry rows run from +height/2 down, so row 0 is the far end.
      const t = row / HOLD_SEGMENTS;
      const z = farZ + (nearZ - farZ) * t;
      const halfWidth = LANE_WIDTH * 0.3 * curveWidth(z);
      const x = this.laneX(lane) * curveWidth(z);
      // Just above the floor and just below the note pills, so it reads as
      // lying on the track rather than floating over it.
      const y = 0.02 + curveLift(z);

      for (let col = 0; col < 2; col++) {
        const index = row * 2 + col;
        position.setXYZ(index, x + (col === 0 ? -halfWidth : halfWidth), y, z);
      }
    }

    position.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }

  private buildNotes(): THREE.InstancedMesh {
    // Real 3D geometry, not a painted tile. A rounded rectangle extruded into a
    // slab with BEVELLED edges, lit by the scene's key light so the chamfers
    // catch a highlight on top and shade underneath — genuinely three-dimensional
    // metal, which a flat quad with a baked-in bevel could never fake at this
    // camera angle. Sized in world units here (not per-instance-scaled from a
    // unit cube), so the bevel stays even.
    const geometry = Highway.makeTileGeometry();

    // Real metal, not a Phong hotspot. What actually makes something read as
    // metal is *reflection*: a metal surface shows its surroundings, tinted by
    // its own colour. So the notes use MeshStandardMaterial with metalness 1 and
    // low roughness, and the scene carries a small procedural environment map
    // (set in the constructor) for them to reflect. The gold comes from
    // `instanceColor` tinting the reflection. `fog:false` so distant notes don't
    // fade out before arriving.
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1,
      roughness: 0.25,
      envMapIntensity: 1.9,
      // A self-glow in the theme's accent so the metal pushes past the bloom
      // threshold and haloes a little, without washing out the reflection that
      // makes it read as metal. Tinted per theme so a cyan theme glows cyan.
      emissive: this.accent,
      emissiveIntensity: 0.4,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** A soft rounded-rect glow, shaped to the tile, for the outer glow it casts on the lane. */
  private static makeGlowTexture(aspect: number): THREE.CanvasTexture {
    const w = 128;
    const h = Math.round(w * aspect);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // A small rounded rect blurred hard, so it feathers out into a glow that
      // reaches zero alpha WELL before the canvas edge — otherwise the still-lit
      // blur meets the quad boundary and reads as a hard rectangular cut. The
      // generous pad plus the blur radius guarantees a fully transparent margin.
      const pad = Math.round(w * 0.24);
      ctx.filter = `blur(${Math.round(w * 0.1)}px)`;
      Highway.roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, Math.round((w - pad * 2) * 0.45));
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
    }

    return new THREE.CanvasTexture(canvas);
  }

  /** A rounded-rect slab with bevelled edges, laid flat on the track (thickness up). */
  private static makeTileGeometry(): THREE.ExtrudeGeometry {
    const w = TILE_WIDTH;
    const d = TILE_DEPTH;
    const r = Math.min(w, d) * 0.22;
    const x0 = -w / 2;
    const y0 = -d / 2;

    const shape = new THREE.Shape();
    shape.moveTo(x0 + r, y0);
    shape.lineTo(x0 + w - r, y0);
    shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    shape.lineTo(x0 + w, y0 + d - r);
    shape.quadraticCurveTo(x0 + w, y0 + d, x0 + w - r, y0 + d);
    shape.lineTo(x0 + r, y0 + d);
    shape.quadraticCurveTo(x0, y0 + d, x0, y0 + d - r);
    shape.lineTo(x0, y0 + r);
    shape.quadraticCurveTo(x0, y0, x0 + r, y0);

    const geometry = new THREE.ExtrudeGeometry(shape, {
      // Thinner slab than before, with a rounder edge: more bevel segments turn
      // the chamfer into a soft rounded-over lip instead of a hard facet.
      depth: 0.1,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.08,
      bevelSegments: 4,
      steps: 1,
      curveSegments: 14,
    });
    // Extruded along +Z; lay it flat so thickness runs up (+Y) and depth into
    // the screen. Keep the extrude's own normals (no recompute) so the bevel
    // facets stay crisp rather than smoothing into a dome.
    geometry.rotateX(-Math.PI / 2);
    geometry.computeBoundingBox();
    // Seat the base on the track: shift so the lowest point sits at y = 0.
    geometry.translate(0, -(geometry.boundingBox?.min.y ?? 0), 0);
    return geometry;
  }

  /**
   * A tiny equirectangular environment for the metal notes to reflect. Vertical
   * axis is elevation: a dim warm sky up top, a hot near-white band where the
   * key light sits, a warm horizon, then a dark floor. Metal reflecting this
   * shows a bright streak that slides across the face as the tile tilts and
   * moves — the moving highlight that reads as polished metal. Cheap: a 256x128
   * canvas gradient, mipmapped so the material's roughness can soften it.
   */
  private static makeEnvTexture(): THREE.CanvasTexture {
    const w = 256;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Neutral greyscale, kept bright throughout. Metal reflects this tinted by
      // the note's own accent colour, so a neutral environment lets every theme's
      // colour read true (a warm-gold env muddied cyan and green metals); and the
      // bright floor keeps the tiles from going near-black where they'd reflect a
      // dark ground. The near-white band is the overhead key light's reflection.
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, 'rgb(120,120,120)');
      g.addColorStop(0.28, 'rgb(180,180,180)');
      g.addColorStop(0.4, 'rgb(255,255,255)');
      g.addColorStop(0.52, 'rgb(190,190,190)');
      g.addColorStop(0.62, 'rgb(120,120,120)');
      g.addColorStop(1.0, 'rgb(80,80,80)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private buildNoteGlow(): THREE.InstancedMesh {
    // A flat quad lying on the highway, so the glow reads as light spilling
    // onto the lane rather than as a sprite floating in front of it. In stage
    // style it is a rounded-rect glow shaped to the bar (a round dot under a
    // rectangle read as a weird blob); classic keeps the soft dot.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      map: this.stage ? Highway.makeGlowTexture(TILE_DEPTH / TILE_WIDTH) : Highway.makeDotTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  private buildParticles(): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.particleColors, 3));

    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.19,
        map: Highway.makeDotTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  // --- public API ----------------------------------------------------------

  /**
   * Which lane a tap at this canvas position belongs to.
   *
   * Lives here because the renderer is the only thing that knows where a lane
   * actually ends up on screen. The play screen used to split the canvas into
   * equal columns, which is wrong: perspective converges the lanes, so they are
   * not evenly spaced and the outer ones land a whole lane out.
   *
   * Projecting the receptors and taking the nearest in x covers perspective,
   * the width taper and the lane count for free, rather than assuming any
   * particular spacing.
   *
   * @param xRatio 0..1 across the canvas, 0..1 down it.
   */
  laneAtScreenPoint(xRatio: number, _yRatio: number): number {
    const tapUvX = xRatio;

    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let lane = 0; lane < this.laneCount; lane++) {
      // Receptors sit at z = 0, where the curve and the taper are both identity.
      this.probe.set(this.laneX(lane), 0, 0);
      this.probe.project(this.camera);
      // NDC (-1..1) to uv (0..1).
      const laneUvX = this.probe.x * 0.5 + 0.5;

      const distance = Math.abs(laneUvX - tapUvX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = lane;
      }
    }

    return best;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width, height);

    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = this.fovFor(aspect);
    this.camera.updateProjectionMatrix();

    // Raise the hit line on portrait phones, where it otherwise sits right
    // against the bottom edge — awkward for a thumb and cramped against the
    // phone's gesture bar. `setViewOffset` pans the projection up without
    // touching the 3D framing or the perspective; a positive y-offset shows a
    // window lower in the virtual frame, which slides the whole scene (and the
    // receptors with it) upward. Cleared on landscape so desktop is untouched.
    // Must come *after* updateProjectionMatrix, which resets the offset.
    if (aspect < PORTRAIT_ASPECT) {
      this.camera.setViewOffset(width, height, 0, height * HIT_RAISE_FRACTION, width, height);
    } else {
      this.camera.clearViewOffset();
    }
  }

  /**
   * Vertical FOV wide enough that the whole lane spread fits horizontally.
   *
   * A PerspectiveCamera's `fov` is vertical, so horizontal coverage shrinks
   * with the aspect ratio: on a portrait phone a five-lane board runs off both
   * sides at the desktop FOV. Widen only as much as the viewport requires, so
   * desktop is untouched.
   */
  private fovFor(aspect: number): number {
    const distanceToHitLine = Math.hypot(this.camHeight, CAMERA_DISTANCE);
    const requiredHalfWidth = this.halfWidth * 1.18; // a little breathing room
    const horizontalHalf = Math.atan(requiredHalfWidth / distanceToHitLine);
    const verticalHalf = Math.atan(Math.tan(horizontalHalf) / Math.max(0.1, aspect));

    const needed = THREE.MathUtils.radToDeg(verticalHalf) * 2;
    return Math.min(MAX_FOV, Math.max(BASE_FOV, needed));
  }

  /** Flash a lane, e.g. when its key goes down. */
  flashLane(lane: number, intensity = 1): void {
    if (lane < 0 || lane >= this.laneCount) return;
    this.laneFlash[lane] = Math.min(1.6, (this.laneFlash[lane] ?? 0) + intensity);
  }

  /**
   * Big hit impact at a lane's receptor: particle burst, an expanding
   * shockwave ring, a camera punch, and a screen shake that grows with the
   * combo. `combo` is the streak *after* this hit — higher combo, harder hit.
   */
  burst(lane: number, tier: Tier, combo = 0): void {
    if (lane < 0 || lane >= this.laneCount) return;

    const count = tier === 'perfect' ? 56 : tier === 'great' ? 40 : tier === 'good' ? 24 : 12;
    const speed = tier === 'perfect' ? 5.0 : 3.4;
    this.color.setHex(tier === 'miss' ? 0x662233 : laneColor(this.theme, lane));
    const x = this.laneX(lane);

    if (tier !== 'miss') {
      this.punch = Math.min(1, this.punch + (tier === 'perfect' ? 0.6 : 0.36));
      this.triggerShockwave(lane, this.color);

      // Shake grows with the streak and caps, so a long combo *feels* heavier
      // without ever getting so violent the lanes become unreadable. A perfect
      // hits harder than a good.
      const comboFactor = Math.min(1, combo / 40);
      const base = tier === 'perfect' ? 0.16 : tier === 'great' ? 0.11 : 0.07;
      this.shake = Math.min(0.42, this.shake + base * (0.6 + comboFactor));
    }

    for (let i = 0; i < count; i++) {
      const p = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % MAX_PARTICLES;

      const angle = Math.random() * Math.PI * 2;
      const lift = 0.4 + Math.random() * 1.3;
      // Some fly out fast, some drift — a mix of radii reads as a spray "all
      // around" rather than a tidy uniform fan.
      const spread = 0.5 + Math.random() * 0.9;

      this.particlePositions[p * 3] = x + (Math.random() - 0.5) * 0.7;
      this.particlePositions[p * 3 + 1] = 0.12;
      this.particlePositions[p * 3 + 2] = 0.2 + (Math.random() - 0.5) * 0.6;

      // Wider lateral and depth fan than before, so the burst throws particles
      // out to the sides and toward the camera instead of mostly straight up.
      this.particleVelocities[p * 3] = Math.cos(angle) * speed * 0.6 * spread;
      this.particleVelocities[p * 3 + 1] = lift * speed * 0.55;
      this.particleVelocities[p * 3 + 2] = Math.sin(angle) * speed * 0.42 * spread + 1.2;

      this.particleColors[p * 3] = this.color.r;
      this.particleColors[p * 3 + 1] = this.color.g;
      this.particleColors[p * 3 + 2] = this.color.b;

      this.particleLife[p] = 1;
    }
  }

  private buildShockwaves(): void {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      // A thin flat annulus that starts small at the receptor and expands. Lies
      // on the track (rotateX) so it reads as a ring rushing outward across the
      // lane, not a disc facing the camera.
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.34, 0.46, 40),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          fog: false,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, 0.02, 0);
      mesh.visible = false;
      this.shockwaves.push(mesh);
      this.scene.add(mesh);
    }
  }

  /** Fire a shockwave from a lane's receptor, reusing the oldest pool slot. */
  private triggerShockwave(lane: number, color: THREE.Color): void {
    const slot = this.shockwaveCursor;
    this.shockwaveCursor = (this.shockwaveCursor + 1) % MAX_SHOCKWAVES;

    const mesh = this.shockwaves[slot]!;
    mesh.position.x = this.laneX(lane);
    mesh.material.color.copy(color);
    mesh.visible = true;
    this.shockwaveLife[slot] = 1;
  }

  private updateShockwaves(dt: number): void {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const life = this.shockwaveLife[i]!;
      if (life <= 0) continue;

      const next = life - dt * 3.4; // ~0.3s
      this.shockwaveLife[i] = next;

      const mesh = this.shockwaves[i]!;
      if (next <= 0) {
        mesh.visible = false;
        continue;
      }

      // Grow outward as it fades. `1 - next` runs 0 → 1 over the life.
      const t = 1 - next;
      const scale = 1 + t * 6;
      mesh.scale.set(scale, scale, 1);
      mesh.material.opacity = next * 0.7;
    }
  }

  /**
   * Draw one frame.
   *
   * @param songTime  seconds into the song, from the audio clock (may be negative during lead-in)
   * @param visible   notes currently within the approach window
   * @param dt        seconds since the previous frame, for particle motion only
   */
  render(
    songTime: number,
    visible: readonly NoteState[],
    dt: number,
    bass: number,
    treble: number,
    spectrum?: Uint8Array,
  ): void {
    if (this.disposed) return;

    const pulse = this.beatPulse(songTime);

    this.updateHoldBodies(songTime, visible);
    this.updateNotes(songTime, visible);
    this.updateLanes(dt, pulse);
    this.updateStars(dt, bass);
    this.updateParticles(dt);
    this.updateShockwaves(dt);
    this.updateCamera(dt, songTime, pulse);
    this.updateCoverWave(songTime, pulse, spectrum);

    const floorUniforms = this.floor.material.uniforms;
    floorUniforms['uTime']!.value = songTime;
    floorUniforms['uScroll']!.value = -songTime * 1.6;
    floorUniforms['uBass']!.value = bass;
    floorUniforms['uPulse']!.value = pulse;
    (floorUniforms['uLaneFlash']!.value as Float32Array).set(this.laneFlash);

    const groundUniforms = this.ground.material.uniforms;
    // Half the floor's scroll rate. The ground is further away, so matching the
    // track's speed makes the two read as one sliding sheet.
    groundUniforms['uScroll']!.value = songTime * 3.2;
    groundUniforms['uBass']!.value = bass;
    groundUniforms['uPulse']!.value = pulse;

    const backdropUniforms = this.backdrop.material.uniforms;
    backdropUniforms['uTime']!.value = songTime;
    backdropUniforms['uBass']!.value = bass;
    backdropUniforms['uTreble']!.value = treble;
    backdropUniforms['uPulse']!.value = pulse;

    for (const rail of this.rails) {
      rail.material.uniforms['uBass']!.value = bass;
      rail.material.uniforms['uPulse']!.value = pulse;
    }

    // Dim, sparse motes on the dark stage; the classic look keeps its brighter
    // synthwave starfield.
    (this.stars.material as THREE.PointsMaterial).opacity = this.stage
      ? 0.18 + treble * 0.18
      : 0.55 + treble * 0.45;

    this.bloom.strength = 0.16 + bass * 0.12 + this.punch * 0.2;

    this.composer.render();
  }

  /** 1 on a beat, decaying to 0 before the next one. */
  private beatPulse(songTime: number): number {
    const grid = this.beatGrid;
    if (grid.length === 0) return 0;

    // Reset on a seek or restart.
    if (this.beatCursor > 0 && (grid[this.beatCursor - 1] ?? 0) > songTime) this.beatCursor = 0;
    while (this.beatCursor < grid.length && (grid[this.beatCursor] ?? Infinity) <= songTime) {
      this.beatCursor++;
    }

    const last = grid[this.beatCursor - 1];
    if (last === undefined) return 0;
    return Math.max(0, 1 - (songTime - last) * 5);
  }

  /**
   * Draw the body of every visible hold.
   *
   * The near end is clamped at the hit line, so once the head arrives the body
   * *drains* into the receptor as the song advances rather than sliding past
   * it. That is what makes a hold read as being consumed while it is held.
   */
  private updateHoldBodies(songTime: number, visible: readonly NoteState[]): void {
    let used = 0;

    for (const state of visible) {
      if (used >= MAX_HOLD_BODIES) break;

      if (state.note.type !== 'hold') continue;
      const span = holdSpan(state.note.t, state.note.duration ?? 0, songTime, this.approachSec);
      if (!span) continue;

      const mesh = this.holdBodies[used]!;
      this.layoutHoldBody(mesh, state.note.lane, span.nearZ, span.farZ);
      mesh.visible = true;

      const held = state.hold === 'held';
      const broken = state.hold === 'broken';
      const missed = state.tier === 'miss';

      // Brightest while actually held — the body is the main feedback that the
      // player is doing it right, since the note itself is long gone under
      // their finger. A broken or missed hold drops back to scenery.
      const brightness = held ? 0.85 : broken || missed ? 0.12 : 0.42;
      mesh.material.color.setHex(laneColor(this.theme, state.note.lane));
      mesh.material.color.multiplyScalar(brightness);
      mesh.material.opacity = held ? 0.95 : broken || missed ? 0.3 : 0.7;

      used++;
    }

    for (let i = used; i < this.holdBodies.length; i++) this.holdBodies[i]!.visible = false;
  }

  private updateNotes(songTime: number, visible: readonly NoteState[]): void {
    let count = 0;

    for (const state of visible) {
      if (count >= MAX_NOTE_INSTANCES) break;

      const progress = (state.note.t - songTime) / this.approachSec;
      const z = -progress * HIGHWAY_LENGTH;
      if (z > 3) continue;

      const missed = state.tier === 'miss';
      const missFade = missed ? 0.4 : 1;
      const nearness = Math.max(0, Math.min(1, 1 - progress));
      // Lane positions taper with the track. Without this the notes keep their
      // full-width spacing while the floor narrows underneath them, and the
      // outer lanes visibly hang off the edge in the distance.
      const laneX = this.laneX(state.note.lane) * curveWidth(z);

      // Fade in at the spawn point so notes emerge from the haze rather than
      // popping into existence, matching the floor's far fade.
      const spawnFade = 1 - Math.max(0, Math.min(1, (progress - 0.82) / 0.18));

      // Every note rides the same curve as the floor. Anything that skips this
      // floats off the surface as the track climbs away.
      const lift = curveLift(z);

      // A tile lies flat on the track, so it takes the slope tilt (like the
      // glow), and its width tapers with the floor. A small swell as it arrives
      // lands the hit moment.
      const slope = Math.atan(curveSlope(z));
      const swell = 1 + nearness * 0.06;

      // --- tap tile (3D bevelled slab) ---
      // The geometry is already world-sized, so scale only applies the arrival
      // swell and the track's width taper (X), never the base dimensions.
      this.dummy.position.set(laneX, 0.05 + lift, z);
      this.dummy.rotation.set(slope, 0, 0);
      this.dummy.scale.set(curveWidth(z) * swell, swell, swell);
      this.dummy.updateMatrix();
      this.notes.setMatrixAt(count, this.dummy.matrix);

      // Brighter than the old pill core: the tile's fill is translucent, so it
      // needs more colour to read as solid neon. The texture's opaque white rim
      // carries the bloom, so the tile keeps a crisp lit edge either way.
      this.color.setHex(this.noteHex(state.note.lane));
      this.color.multiplyScalar((0.72 + nearness * 0.3) * missFade * spawnFade);
      this.notes.setColorAt(count, this.color);

      // --- outer glow: light spilling onto the lane around the tile ---
      // Stage: a rounded-rect glow spread beyond the bar's footprint, so it
      // haloes the tile. Classic: the old wide soft dot.
      let glowW: number;
      let glowD: number;
      if (this.stage) {
        const spread = 1.7 + nearness * 0.5;
        glowW = TILE_WIDTH * spread * curveWidth(z);
        glowD = TILE_DEPTH * spread;
      } else {
        glowW = LANE_WIDTH * 1.24 * (0.8 + nearness * 0.4) * curveWidth(z);
        glowD = glowW * 0.64;
      }
      this.dummy.position.set(laneX, 0.015 + lift, z);
      this.dummy.rotation.set(slope, 0, 0);
      this.dummy.scale.set(glowW, 1, glowD);
      this.dummy.updateMatrix();
      this.noteGlow.setMatrixAt(count, this.dummy.matrix);

      this.color.setHex(this.noteHex(state.note.lane));
      // Eased back from 0.38 + 0.7: the halo was bright enough to bleed into
      // its neighbours through the bloom, which softened the tile's own edge.
      const haloScale = this.stage ? 0.85 : 1;
      this.color.multiplyScalar((0.3 + nearness * 0.55) * haloScale * missFade * spawnFade);
      this.noteGlow.setColorAt(count, this.color);

      count++;
    }

    this.notes.count = count;
    this.notes.instanceMatrix.needsUpdate = true;
    if (this.notes.instanceColor) this.notes.instanceColor.needsUpdate = true;

    this.noteGlow.count = count;
    this.noteGlow.instanceMatrix.needsUpdate = true;
    if (this.noteGlow.instanceColor) this.noteGlow.instanceColor.needsUpdate = true;
  }

  private updateLanes(dt: number, pulse: number): void {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const decayed = Math.max(0, (this.laneFlash[lane] ?? 0) - dt * 4.2);
      this.laneFlash[lane] = decayed;

      const pad = this.pads[lane];
      if (pad) pad.material.opacity = 0.16 + decayed * 0.5;

      const frame = this.hitZones[lane];
      if (frame) {
        frame.material.opacity = 0.5 + decayed * 0.5 + pulse * 0.14;
        // A small punch-out on a press, in the plane (X width, Z depth). Uses the
        // tile footprint so the target stays exactly the bar's size — this line
        // overrides the size set in buildReceptors every frame, so it must match.
        const s = 1 + decayed * 0.14;
        frame.scale.set(TILE_WIDTH * s, 1, HIT_ZONE_DEPTH * s);
      }
    }
  }

  private updateCamera(dt: number, songTime: number, pulse: number): void {
    this.punch = Math.max(0, this.punch - dt * 3.2);
    this.shake = Math.max(0, this.shake - dt * 2.6);

    // A little sway and a beat-synced dip keep the frame alive without
    // making the lanes harder to read.
    const sway = Math.sin(songTime * 0.55) * 0.06;

    // Screen shake: a fast random jitter scaled by `shake`. Applied to the
    // camera position and a fraction of it to the look target, so the frame
    // rattles rather than just sliding. Squared falloff (shake*shake) keeps the
    // low, constant end from making the lanes feel permanently loose.
    const s = this.shake * this.shake;
    const shakeX = (Math.random() - 0.5) * s * 1.6;
    const shakeY = (Math.random() - 0.5) * s * 1.2;

    this.camera.position.set(
      sway + shakeX,
      this.camHeight - this.punch * 0.16 - pulse * 0.03 + shakeY,
      CAMERA_DISTANCE - this.punch * 0.3,
    );
    this.camera.lookAt(sway * 0.3 + shakeX * 0.4, shakeY * 0.4, CAMERA_TARGET_Z);
  }

  private updateParticles(dt: number): void {
    const gravity = 7.5;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.particleLife[i] ?? 0;
      if (life <= 0) continue;

      const next = life - dt * 1.6;
      this.particleLife[i] = next;

      if (next <= 0) {
        // Park dead particles far below the camera rather than resizing buffers.
        this.particlePositions[i * 3 + 1] = -999;
        continue;
      }

      this.particleVelocities[i * 3 + 1] = (this.particleVelocities[i * 3 + 1] ?? 0) - gravity * dt;
      this.particlePositions[i * 3] =
        (this.particlePositions[i * 3] ?? 0) + (this.particleVelocities[i * 3] ?? 0) * dt;
      this.particlePositions[i * 3 + 1] =
        (this.particlePositions[i * 3 + 1] ?? 0) + (this.particleVelocities[i * 3 + 1] ?? 0) * dt;
      this.particlePositions[i * 3 + 2] =
        (this.particlePositions[i * 3 + 2] ?? 0) + (this.particleVelocities[i * 3 + 2] ?? 0) * dt;
    }

    this.particles.geometry.attributes['position']!.needsUpdate = true;
    this.particles.geometry.attributes['color']!.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });

    this.composer.dispose();
    this.renderer.dispose();
  }
}

export { HIGHWAY_LENGTH, LANE_WIDTH };
