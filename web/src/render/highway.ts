import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { NoteState } from '../game/engine.js';
import type { Tier } from '../game/judge.js';
import type { Theme } from '@tap-tap/shared';
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
/** World-space distance from the spawn point to the hit line. */
const HIGHWAY_LENGTH = 26;

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
const CURVE_HEIGHT = 1.4;

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
const MAX_PARTICLES = 900;
const STAR_COUNT = 560;

/**
 * Camera rig. Height and distance set how steeply you look down the highway:
 * higher and closer tilts the view further over, which shows more of the lane
 * and makes note spacing easier to read.
 */
const CAMERA_HEIGHT = 6.2;
const CAMERA_DISTANCE = 6.2;
const CAMERA_TARGET_Z = -9;
const BASE_FOV = 60;
/** Upper bound on widening; past this the perspective distortion is worse than the crop. */
const MAX_FOV = 96;

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
  private readonly hitLine: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  private readonly pads: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];

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

  private readonly dummy = new THREE.Object3D();
  /** Scratch vector for projecting receptors during hit testing. */
  private readonly probe = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private disposed = false;

  constructor({ canvas, laneCount, approachSec, theme, beatGrid = [] }: HighwayOptions) {
    this.laneCount = laneCount;
    this.approachSec = approachSec;
    // Assigned before any build* call: every one of them reads it, and a field
    // set after `buildBackdrop()` would be undefined at the moment it is needed.
    this.theme = theme;
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
    this.scene.background = new THREE.Color(theme.sky.top).multiplyScalar(0.3);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
    this.camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, CAMERA_TARGET_Z);

    this.backdrop = this.buildBackdrop();
    this.scene.add(this.backdrop);

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

    this.buildReceptors();

    this.hitLine = this.buildHitLine();
    this.scene.add(this.hitLine);

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

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Tight radius and a high threshold. A wide radius smears the hit line and
    // lit floor across the entire sky as a flat haze, which reads as a washed
    // out background rather than as glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.2, 0.8);
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

  private buildBackdrop(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
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
        /** Just above the horizon line, so the disc reads as half-set. */
        const float SUN_Y = 0.446;
        /** ~7.4 world units. Roughly the sky's height above the horizon. */
        const float SUN_R = 0.062;


        void main() {
          // The sky colours arrive as LINEAR uniforms — THREE.Color converted
          // them from the theme's sRGB hex. ACES tone mapping plus the sRGB
          // transfer curve lifts midtones hard, so a theme whose sky reads as a
          // reasonable hex still has to be a *dark* hex: linear 0.14 lands near
          // sRGB 0.42 on screen.
          //
          // Everything below is deliberately dim. This is a backdrop: the notes
          // and the hit line have to stay the brightest things on screen, so
          // nothing here may cross the bloom threshold (0.8) and start glowing
          // in competition with them. That is a constraint on any new theme, not
          // just on these defaults.
          // The whole sky is the 0.045 of uv between the horizon and the top of
          // frame, so every gradient stop lives inside that sliver.
          float sky = smoothstep(HORIZON, 0.545, vUv.y);

          vec3 horizonCol = mix(uSkyHorizon, uSkyHorizonAlt, 0.3 + uTreble * 0.3);
          vec3 base = mix(horizonCol, uSkyTop, sky);

          // Below eye level the backdrop only peeks past the edges of the
          // track, so it drops away to near-black rather than competing.
          base = mix(base, uSkyBelow, smoothstep(HORIZON, HORIZON - 0.08, vUv.y));

          // --- sun -------------------------------------------------------
          // Anchored in world space, not guessed in uv. The backdrop plane is
          // 120 units tall centred on world y=8, so uv.y = 0.5 + (worldY-8)/120
          // and the camera's eye level (6.2) lands on HORIZON. Sizing from that
          // relationship is what stops the sun coming out either invisible or
          // big enough to fill the frame.
          vec2 sunOffset = vec2((vUv.x - 0.5) * PLANE_ASPECT, vUv.y - SUN_Y);
          float sunDist = length(sunOffset);
          float sunMask = smoothstep(SUN_R, SUN_R - 0.004, sunDist);

          // 0 at the crown, 1 at the waterline.
          float depth = clamp((SUN_Y + SUN_R - vUv.y) / (2.0 * SUN_R), 0.0, 1.0);

          // Horizontal slits, the retrowave signature. The gaps widen toward the
          // bottom so the disc dissolves into the haze instead of being sliced
          // by an even comb, and the crown stays solid.
          float slitPhase = fract(vUv.y * 150.0);
          float gap = mix(0.10, 0.66, depth);
          sunMask *= mix(1.0, step(gap, slitPhase), smoothstep(0.12, 0.5, depth));

          // Hot pink at the horizon into a pale pink crown. Held under the bloom
          // threshold (0.8) so the sun glows without competing with the notes.
          //
          // Pink the whole way up rather than the poster's yellow crown, to
          // match the menu's sun — a warm crown reads as cream here and made the
          // two backgrounds look like different scenes.
          //
          // Ramped across the *visible* half only. Spanning the full disc puts
          // most of the gradient below the horizon where nobody can see it, and
          // the part on screen comes out flat.
          vec3 sunCol = mix(uSun, uSunCrown, smoothstep(HORIZON, SUN_Y + SUN_R, vUv.y));
          // Cut flat at the horizon. The track's far end is far too narrow to
          // hide the disc's base, so without this the sun hangs in the sky as a
          // complete circle instead of setting behind the world.
          sunMask *= step(HORIZON, vUv.y);
          base = mix(base, sunCol, sunMask);

          // Atmospheric bloom around the disc.
          base += uHaze * smoothstep(SUN_R * 2.6, SUN_R * 0.9, sunDist) * 0.5;

          // --- atmosphere ------------------------------------------------
          // The scalars below used to be baked into four separate literals, one
          // per term. They are pulled out as plain multipliers so the *hue* of
          // the air comes from the theme while the relative strengths — which
          // were tuned against the bloom threshold, not against a colour — stay
          // where they were.
          //
          // Drifting nebula, kept subtle: it is texture, not a light source.
          float n = noise(vUv * vec2(5.0, 3.0) + vec2(uTime * 0.03, uTime * 0.015));
          n *= noise(vUv * vec2(11.0, 7.0) - vec2(uTime * 0.02, 0.0));
          base += uGlow * 0.34 * n * (0.05 + uTreble * 0.14) * sky;

          // Haze hugging the horizon, so the sky meets the track through air
          // rather than at a hard line.
          base += uHaze * 0.34 * smoothstep(0.022, 0.0, abs(vUv.y - HORIZON)) * 0.40;

          // Glow at the vanishing point, swelling on the low end and each beat.
          float d = distance(vUv, vec2(0.5, 0.44));
          float glow = smoothstep(0.20, 0.0, d) * (0.03 + uBass * 0.18 + uPulse * 0.10);
          base += uGlow * glow;



          gl_FragColor = vec4(base, 1.0);
        }
      `,
    });

    // Sized to overshoot the frustum in every direction: a visible plane edge
    // reads as a hard seam across the sky.
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 120), material);
    mesh.position.set(0, 8, -HIGHWAY_LENGTH - 14);
    mesh.renderOrder = -2;
    return mesh;
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

          float alpha = grid * clear * farFade * nearFade * sideFade
                      * (0.34 + uBass * 0.20 + uPulse * 0.10);

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
          float laneBody = nearGlow * (0.14 + uBass * 0.22 + uPulse * 0.08);

          // A press lights the whole lane, not just the near end. The constant
          // term is what carries the highlight all the way up the highway;
          // without it the flash collapses into the hit line and reads as a
          // separate object rather than as "this lane".
          float flashGlow = flash * (0.34 + nearGlow * 0.85);

          vec3 col = tint * (laneBody + flashGlow)
                   + tint * separator * 0.22
                   + vec3(0.55, 0.75, 1.0) * rungs * 0.28;

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

  private buildReceptors(): void {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const hex = laneColor(this.theme, lane);

      const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(LANE_WIDTH * 0.96, 1.35),
        new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.18,
          toneMapped: false,
        }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(this.laneX(lane), -0.07, 0);
      this.pads.push(pad);
      this.scene.add(pad);

      // Nearly the full lane width, and thick enough to read at a glance —
      // the receptors are the one thing the player's eye rests on.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(LANE_WIDTH * 0.34, LANE_WIDTH * 0.48, 40),
        new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(this.laneX(lane), -0.05, 0);
      this.rings.push(ring);
      this.scene.add(ring);
    }
  }

  private buildHitLine(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(this.halfWidth * 2 + 0.5, 0.1),
      new THREE.MeshBasicMaterial({
        color: this.theme.hitLine,
        transparent: true,
        opacity: 0.95,
        toneMapped: false,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    // z=0, on the receptor centres — NOT in front of them.
    //
    // This sat at z=0.45 and was actively teaching bad timing. The bar is the
    // brightest, sharpest thing on the track, so it reads as *the* target, but
    // 0.45 world units is 22ms on hard and 33ms on easy — the bright line
    // marked a moment a player could only reach by tapping late. Meanwhile the
    // receptor ring is far wider than a note, so the pill *touches* it ~40ms
    // early. The two obvious cues bracketed the real moment and neither one
    // marked it, which showed up as a player scoring `perfect` while reading
    // 80% EARLY. Kept 0.01 above the rings (y=-0.04 vs -0.05) so it still
    // composites cleanly over them rather than z-fighting.
    mesh.position.set(0, -0.04, 0);
    return mesh;
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
    // A pill reads better than a box at this camera angle: the rounded caps
    // catch the bloom and give the note a soft, playful silhouette. Kept close
    // to round — a long thin capsule reads as a dash rather than as an object.
    const geometry = new THREE.CapsuleGeometry(0.2, LANE_WIDTH * 0.14, 6, 18);
    geometry.rotateZ(Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      // Deliberately no `vertexColors`: InstancedMesh supplies per-instance
      // tints via `instanceColor`. Turning vertexColors on makes the shader
      // look for a per-vertex `color` attribute this geometry has never had,
      // and every note renders black.
      //
      // `fog: false` matters as much: scene fog fades toward near-black well
      // before the spawn distance, so fogged notes arrive nearly invisible.
      toneMapped: false,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_NOTE_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    return mesh;
  }

  private buildNoteGlow(): THREE.InstancedMesh {
    // A flat quad lying on the highway, so the glow reads as light spilling
    // onto the lane rather than as a sprite floating in front of it.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      map: Highway.makeDotTexture(),
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
    const distanceToHitLine = Math.hypot(CAMERA_HEIGHT, CAMERA_DISTANCE);
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

  /** Spawn a burst at a lane's receptor. */
  burst(lane: number, tier: Tier): void {
    if (lane < 0 || lane >= this.laneCount) return;

    const count = tier === 'perfect' ? 34 : tier === 'great' ? 24 : tier === 'good' ? 14 : 8;
    const speed = tier === 'perfect' ? 4.6 : 3.2;
    this.color.setHex(tier === 'miss' ? 0x662233 : laneColor(this.theme, lane));
    const x = this.laneX(lane);

    if (tier !== 'miss') this.punch = Math.min(1, this.punch + (tier === 'perfect' ? 0.5 : 0.3));

    for (let i = 0; i < count; i++) {
      const p = this.particleCursor;
      this.particleCursor = (this.particleCursor + 1) % MAX_PARTICLES;

      const angle = Math.random() * Math.PI * 2;
      const lift = 0.4 + Math.random() * 1.1;

      this.particlePositions[p * 3] = x + (Math.random() - 0.5) * 0.5;
      this.particlePositions[p * 3 + 1] = 0.12;
      this.particlePositions[p * 3 + 2] = 0.2 + (Math.random() - 0.5) * 0.4;

      this.particleVelocities[p * 3] = Math.cos(angle) * speed * 0.34;
      this.particleVelocities[p * 3 + 1] = lift * speed * 0.55;
      this.particleVelocities[p * 3 + 2] = Math.sin(angle) * speed * 0.22 + 1.2;

      this.particleColors[p * 3] = this.color.r;
      this.particleColors[p * 3 + 1] = this.color.g;
      this.particleColors[p * 3 + 2] = this.color.b;

      this.particleLife[p] = 1;
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
  ): void {
    if (this.disposed) return;

    const pulse = this.beatPulse(songTime);

    this.updateHoldBodies(songTime, visible);
    this.updateNotes(songTime, visible);
    this.updateLanes(dt, pulse);
    this.updateStars(dt, bass);
    this.updateParticles(dt);
    this.updateCamera(dt, songTime, pulse);

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

    this.hitLine.material.opacity = 0.75 + pulse * 0.25;
    (this.stars.material as THREE.PointsMaterial).opacity = 0.55 + treble * 0.45;

    this.bloom.strength = 0.45 + bass * 0.25 + this.punch * 0.3;

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

      // --- solid core: near-constant brightness, so the edges stay crisp ---
      this.dummy.position.set(laneX, 0.1 + lift, z);
      // The pill is a capsule lying along X, so it is a surface of revolution
      // about that axis — tilting it into the slope would change nothing.
      this.dummy.rotation.set(0, 0, 0);
      // A gentle swell as the note arrives makes the hit moment land.
      this.dummy.scale.setScalar((0.86 + nearness * 0.22) * missFade);
      this.dummy.updateMatrix();
      this.notes.setMatrixAt(count, this.dummy.matrix);

      // Deliberately kept under the bloom threshold (0.8): anything above it
      // blooms into its own silhouette and the pill loses its edges. All the
      // glow comes from the halo below, so the core only has to be legible.
      this.color.setHex(laneColor(this.theme, state.note.lane));
      this.color.multiplyScalar((0.62 + nearness * 0.2) * missFade * spawnFade);
      this.notes.setColorAt(count, this.color);

      // --- halo: carries all the glow, and every note gets one ---
      // Scaled by the taper too, so the halo keeps covering roughly one lane
      // rather than spilling across a narrowed track in the distance.
      const glowSize = LANE_WIDTH * 1.32 * (0.75 + nearness * 0.45) * curveWidth(z);
      this.dummy.position.set(laneX, 0.015 + lift, z);
      // The halo is a flat quad meant to read as light spilling onto the lane,
      // so unlike the pill it has to lie *along* the slope. Left level it would
      // cut through the rising track and shear into a hard edge.
      this.dummy.rotation.set(Math.atan(curveSlope(z)), 0, 0);
      this.dummy.scale.set(glowSize, 1, glowSize);
      this.dummy.updateMatrix();
      this.noteGlow.setMatrixAt(count, this.dummy.matrix);

      this.color.setHex(laneColor(this.theme, state.note.lane));
      // Eased back from 0.38 + 0.7: the halo was bright enough to bleed into
      // its neighbours through the bloom, which softened the pill's own edge.
      // The core carries legibility, so the halo can afford to sit lower.
      this.color.multiplyScalar((0.3 + nearness * 0.55) * missFade * spawnFade);
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

      const ring = this.rings[lane];
      if (ring) {
        ring.material.opacity = 0.45 + decayed * 0.55 + pulse * 0.15;
        const scale = 1 + decayed * 0.32;
        ring.scale.set(scale, scale, 1);
      }
    }
  }

  private updateCamera(dt: number, songTime: number, pulse: number): void {
    this.punch = Math.max(0, this.punch - dt * 3.2);

    // A little sway and a beat-synced dip keep the frame alive without
    // making the lanes harder to read.
    const sway = Math.sin(songTime * 0.55) * 0.06;
    this.camera.position.set(
      sway,
      CAMERA_HEIGHT - this.punch * 0.16 - pulse * 0.03,
      CAMERA_DISTANCE - this.punch * 0.3,
    );
    this.camera.lookAt(sway * 0.3, 0, CAMERA_TARGET_Z);
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
