import { useEffect, useRef, type CSSProperties, type JSX } from 'react';
import { AURA_PRESETS, type AuraVariant, pickAuraVariant, rgbFromAccent } from '../render/aura.js';

/**
 * The living halo behind an album disc — recolouring embers / light-rays / glow
 * that make the menu hero and results ceremony feel alive (the Beatstar look).
 *
 * A hand-rolled canvas particle system built for *bloom*: particles are drawn
 * from pre-tinted sprites (streaks with white-hot heads, glowing embers, 4-point
 * sparkle stars, a core ring) onto an offscreen buffer, which is then composited
 * back with a blurred half-res copy underneath it — cheap two-pass bloom that
 * gives the neon light-bleed a flat additive draw can't. Sprites are re-tinted
 * only when the accent changes.
 *
 * The accent and variant are read from refs each frame, so recolouring when the
 * selected song changes never tears down the loop. The colour/variant maths is
 * the pure, unit-tested `render/aura.ts`; this file is only the drawing.
 */

interface SongAuraProps {
  /** 0xRRGGBB — the song's theme accent. Recolours live. */
  accent: number;
  /** Force a style; by default it's chosen from the accent hue. */
  variant?: AuraVariant;
  /** Disc radius as a fraction of the canvas half-size — particles emit from
   *  this rim. 0.5 means the disc fills half the canvas. */
  disc?: number;
  /** Global density/brightness multiplier. */
  intensity?: number;
  className?: string;
  style?: CSSProperties;
}

type Kind = 'ray' | 'ember' | 'sparkle';

interface Particle {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rad: number; // current radius from centre (rays)
  angle: number;
  len: number;
  size: number;
  rot: number;
  spin: number;
  age: number;
  ttl: number;
  seed: number;
  flare: number; // 0..1 extra thickness/brightness for hero rays
}

const TAU = Math.PI * 2;
const MAX_PARTICLES = 760;

/** A bright-headed streak: transparent tail → accent → white-hot head, soft edge. */
function makeStreakSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const w = 180;
  const h = 22;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  const lg = x.createLinearGradient(0, 0, w, 0);
  const hi = (n: number): number => Math.min(255, n + 70);
  lg.addColorStop(0, `rgba(${r},${g},${b},0)`);
  lg.addColorStop(0.55, `rgba(${r},${g},${b},0.32)`);
  lg.addColorStop(0.88, `rgba(${r},${g},${b},0.8)`);
  lg.addColorStop(0.97, `rgba(${hi(r)},${hi(g)},${hi(b)},0.9)`);
  lg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = lg;
  x.fillRect(0, 0, w, h);
  // Soft vertical falloff so the streak has feathered edges, not a hard bar.
  const vg = x.createLinearGradient(0, 0, 0, h);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.5, 'rgba(0,0,0,1)');
  vg.addColorStop(1, 'rgba(0,0,0,0)');
  x.globalCompositeOperation = 'destination-in';
  x.fillStyle = vg;
  x.fillRect(0, 0, w, h);
  return c;
}

/** A soft round glowing blob with a hot core — the ember / mote body. */
function makeBlobSprite(r: number, g: number, b: number, warm: boolean): HTMLCanvasElement {
  const s = 96;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const x = c.getContext('2d')!;
  const core = warm ? [255, 240, 205] : [Math.min(255, r + 110), Math.min(255, g + 110), Math.min(255, b + 110)];
  const rg = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, `rgba(${core[0]},${core[1]},${core[2]},1)`);
  rg.addColorStop(0.28, `rgba(${r},${g},${b},0.85)`);
  rg.addColorStop(0.7, `rgba(${r},${g},${b},0.22)`);
  rg.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = rg;
  x.beginPath();
  x.arc(s / 2, s / 2, s / 2, 0, TAU);
  x.fill();
  return c;
}

/** A crisp 4-point sparkle star: two tapered white spikes over a small glow. */
function makeSparkleSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const x = c.getContext('2d')!;
  const m = s / 2;
  // Central glow.
  const rg = x.createRadialGradient(m, m, 0, m, m, m * 0.5);
  rg.addColorStop(0, 'rgba(255,255,255,0.9)');
  rg.addColorStop(0.5, `rgba(${r},${g},${b},0.4)`);
  rg.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = rg;
  x.beginPath();
  x.arc(m, m, m, 0, TAU);
  x.fill();
  // Four tapered spikes (a stretched diamond each way).
  const spike = (horizontal: boolean): void => {
    const g2 = horizontal ? x.createLinearGradient(0, 0, s, 0) : x.createLinearGradient(0, 0, 0, s);
    g2.addColorStop(0, 'rgba(255,255,255,0)');
    g2.addColorStop(0.5, 'rgba(255,255,255,1)');
    g2.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g2;
    x.beginPath();
    if (horizontal) {
      x.moveTo(0, m);
      x.lineTo(m, m - 2.2);
      x.lineTo(s, m);
      x.lineTo(m, m + 2.2);
    } else {
      x.moveTo(m, 0);
      x.lineTo(m - 2.2, m);
      x.lineTo(m, s);
      x.lineTo(m + 2.2, m);
    }
    x.closePath();
    x.fill();
  };
  x.globalCompositeOperation = 'lighter';
  spike(true);
  spike(false);
  return c;
}

/** A soft ring glow that hugs the disc rim (transparent centre, bright ring). */
function makeCoreSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const x = c.getContext('2d')!;
  const rg = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0, `rgba(${r},${g},${b},0)`);
  rg.addColorStop(0.52, `rgba(${r},${g},${b},0)`);
  rg.addColorStop(0.64, `rgba(${r},${g},${b},0.5)`);
  rg.addColorStop(0.72, `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)},0.32)`);
  rg.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = rg;
  x.fillRect(0, 0, s, s);
  return c;
}

export function SongAura({
  accent,
  variant,
  disc = 0.5,
  intensity = 1,
  className,
  style,
}: SongAuraProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const accentRef = useRef(accent);
  const variantRef = useRef<AuraVariant>(variant ?? pickAuraVariant(accent));
  const intensityRef = useRef(intensity);
  accentRef.current = accent;
  variantRef.current = variant ?? pickAuraVariant(accent);
  intensityRef.current = intensity;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // Offscreen buffers: `buf` is the crisp particle layer, `glow` a half-res
    // blurred copy composited underneath it for bloom.
    const buf = document.createElement('canvas');
    const bctx = buf.getContext('2d')!;
    const glow = document.createElement('canvas');
    const gctx = glow.getContext('2d')!;

    let W = 0;
    let H = 0;
    const resize = (): void => {
      W = Math.max(1, Math.round(canvas.clientWidth * dpr));
      H = Math.max(1, Math.round(canvas.clientHeight * dpr));
      canvas.width = W;
      canvas.height = H;
      buf.width = W;
      buf.height = H;
      glow.width = Math.max(1, Math.round(W / 2));
      glow.height = Math.max(1, Math.round(H / 2));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Sprites, re-tinted only when accent/variant changes.
    let spriteKey = '';
    let streak: HTMLCanvasElement;
    let blob: HTMLCanvasElement;
    let sparkle: HTMLCanvasElement;
    let core: HTMLCanvasElement;
    const ensureSprites = (): void => {
      const key = `${accentRef.current}|${variantRef.current}`;
      if (key === spriteKey) return;
      spriteKey = key;
      const { r, g, b } = rgbFromAccent(accentRef.current);
      streak = makeStreakSprite(r, g, b);
      blob = makeBlobSprite(r, g, b, variantRef.current === 'ember');
      sparkle = makeSparkleSprite(r, g, b);
      core = makeCoreSprite(r, g, b);
    };

    const particles: Particle[] = [];
    let emitAcc = 0;
    let sparkAcc = 0;
    let fieldRot = 0;
    let last = performance.now();
    let raf = 0;

    const spawn = (kind: Kind): void => {
      if (particles.length >= MAX_PARTICLES) return;
      const p = AURA_PRESETS[variantRef.current];
      // Emit rim tracks the disc (smaller dimension); ray *reach* uses the
      // larger dimension so rays cross clear to the far screen edges rather than
      // stopping short in the tall direction.
      const minHalf = Math.min(W, H) / 2;
      const maxHalf = Math.max(W, H) / 2;
      const rim = disc * minHalf;
      const angle = Math.random() * TAU;
      if (kind === 'ray') {
        const flare = Math.random() < 0.08 ? 0.6 + Math.random() * 0.4 : 0;
        const len = (p.length[0] + Math.random() * (p.length[1] - p.length[0])) * maxHalf;
        const spd = (p.speed[0] + Math.random() * (p.speed[1] - p.speed[0])) * maxHalf;
        particles.push({
          kind,
          x: 0,
          y: 0,
          vx: spd,
          vy: 0,
          rad: rim * (0.86 + Math.random() * 0.18),
          angle,
          len,
          size: Math.max(2 * dpr, p.size * minHalf) * (1 + flare * 2.5),
          rot: 0,
          spin: 0,
          age: 0,
          ttl: 0.5 + Math.random() * 0.7,
          seed: Math.random(),
          flare,
        });
      } else if (kind === 'sparkle') {
        const rr = rim * (0.8 + Math.random() * 1.1);
        particles.push({
          kind,
          x: Math.cos(angle) * rr,
          y: Math.sin(angle) * rr,
          vx: 0,
          vy: 0,
          rad: rr,
          angle,
          len: 0,
          size: (0.035 + Math.random() * 0.06) * minHalf,
          rot: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 1.5,
          age: 0,
          ttl: 0.5 + Math.random() * 0.6,
          seed: Math.random(),
          flare: 0,
        });
      } else {
        // ember / mote
        const spd = (p.speed[0] + Math.random() * (p.speed[1] - p.speed[0])) * minHalf;
        const jitter = (Math.random() - 0.5) * 0.6;
        particles.push({
          kind,
          x: Math.cos(angle) * rim * (0.9 + Math.random() * 0.16),
          y: Math.sin(angle) * rim * (0.9 + Math.random() * 0.16),
          vx: Math.cos(angle) * spd + jitter * minHalf * 0.1,
          vy: Math.sin(angle) * spd - p.rise * minHalf,
          rad: rim,
          angle,
          len: 0,
          size: p.size * minHalf * (0.55 + Math.random() * 0.9),
          rot: 0,
          spin: 0,
          age: 0,
          ttl: 0.7 + Math.random() * 1.1,
          seed: Math.random(),
          flare: 0,
        });
      }
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ensureSprites();

      const cx = W / 2;
      const cy = H / 2;
      const half = Math.min(W, H) / 2;
      if (half <= 0) return;
      const preset = AURA_PRESETS[variantRef.current];
      const t = now / 1000;
      const inten = intensityRef.current;

      // --- draw particle layer onto the buffer -----------------------------
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, W, H);
      bctx.globalCompositeOperation = 'lighter';

      // Core ring hugging the disc, breathing.
      const breathe = 1 + preset.pulse * 0.16 * Math.sin(t * 2.4);
      const coreD = disc * half * 2 * 1.5 * breathe + preset.halo * half;
      bctx.globalAlpha = (0.32 + 0.12 * Math.sin(t * 2.4)) * inten;
      bctx.drawImage(core, cx - coreD / 2, cy - coreD / 2, coreD, coreD);
      bctx.globalAlpha = 1;

      // A slow rotation of the whole ray field, so the starburst churns rather
      // than sitting dead still.
      fieldRot += dt * 0.06;

      // Emit.
      if (!reduce) {
        emitAcc += preset.spawnRate * inten * dt;
        const primary: Kind = variantRef.current === 'burst' ? 'ray' : 'ember';
        while (emitAcc >= 1) {
          spawn(primary);
          emitAcc -= 1;
        }
        sparkAcc += preset.sparkleRate * inten * dt;
        while (sparkAcc >= 1) {
          spawn('sparkle');
          sparkAcc -= 1;
        }
      }

      const dragK = Math.pow(preset.drag, dt);
      for (let i = particles.length - 1; i >= 0; i--) {
        const q = particles[i];
        q.age += dt / q.ttl;
        if (q.age >= 1) {
          particles.splice(i, 1);
          continue;
        }
        const fade = Math.sin(Math.PI * q.age);

        if (q.kind === 'ray') {
          q.rad += q.vx * dt;
          q.vx *= dragK;
          bctx.globalAlpha = fade * inten;
          bctx.save();
          bctx.translate(cx, cy);
          bctx.rotate(q.angle + fieldRot);
          bctx.drawImage(streak, q.rad - q.len, -q.size / 2, q.len, q.size);
          // Flare rays get a second pass for a brighter, fatter beam.
          if (q.flare > 0) bctx.drawImage(streak, q.rad - q.len, -q.size / 2, q.len, q.size);
          bctx.restore();
        } else if (q.kind === 'sparkle') {
          q.rot += q.spin * dt;
          // Twinkle: a fast shimmer on top of the birth/death fade.
          const tw = fade * (0.55 + 0.45 * Math.sin(t * 9 + q.seed * TAU));
          const s = q.size * (0.7 + 0.5 * fade);
          bctx.globalAlpha = Math.max(0, tw) * inten;
          bctx.save();
          bctx.translate(cx + q.x, cy + q.y);
          bctx.rotate(q.rot);
          bctx.drawImage(sparkle, -s / 2, -s / 2, s, s);
          bctx.restore();
        } else {
          // ember / mote
          if (preset.swirl !== 0) {
            const a = preset.swirl * dt;
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            const vx = q.vx * cos - q.vy * sin;
            const vy = q.vx * sin + q.vy * cos;
            q.vx = vx;
            q.vy = vy;
          }
          q.vx *= dragK;
          q.vy *= dragK;
          q.vy -= preset.rise * half * dt * 0.6; // keep rising as it ages
          q.x += q.vx * dt;
          q.y += q.vy * dt;
          const flick = 0.75 + 0.25 * Math.sin(t * 14 + q.seed * 40);
          const s = q.size * (0.6 + 0.4 * fade);
          bctx.globalAlpha = fade * flick * inten;
          bctx.drawImage(blob, cx + q.x - s / 2, cy + q.y - s / 2, s, s);
        }
      }
      bctx.globalAlpha = 1;

      // --- bloom: blurred half-res copy under the crisp layer ---------------
      gctx.setTransform(1, 0, 0, 1, 0, 0);
      gctx.globalCompositeOperation = 'source-over';
      gctx.clearRect(0, 0, glow.width, glow.height);
      gctx.filter = `blur(${preset.bloom}px)`;
      gctx.drawImage(buf, 0, 0, glow.width, glow.height);
      gctx.filter = 'none';

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      ctx.drawImage(glow, 0, 0, W, H); // bloom
      ctx.drawImage(glow, 0, 0, W, H); // a soft second pass for the light-bleed
      ctx.globalAlpha = 0.85;
      ctx.drawImage(buf, 0, 0); // crisp cores on top
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disc]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
