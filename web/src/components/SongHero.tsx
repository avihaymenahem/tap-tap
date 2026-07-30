import type { DifficultyName, SongSummary } from '@tap-tap/shared';
import { ChevronDown, Play, SkipBack, SkipForward, Users } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import { accentVars } from '../accent.js';
import { primeAudio } from '../game/clock.js';
import { getStoredModifiers, setStoredModifiers } from '../storage.js';
import { ElectricArcs } from './ElectricArcs.js';
import { ModifierPanel } from './ModifierPanel.js';
import { SongAura } from './SongAura.js';

interface HeroBest {
  grade: string;
  score: number;
  accuracy: number;
  maxCombo: number;
}

interface SongHeroProps {
  song: SongSummary;
  accent: number;
  /** Difficulties this song actually has a chart for. */
  available: readonly DifficultyName[];
  /** The resolved difficulty (nearest available to the preference). */
  difficulty: DifficultyName | undefined;
  onSelectDifficulty: (name: DifficultyName) => void;
  best: HeroBest | null;
  onPlay: () => void;
  /** Start the same chart as a two-player match on this one phone. */
  onVersus: () => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * The full-screen "now focused" hero — a huge album disc wrapped in the living
 * `SongAura`, over a wash of the song's own colour, with the difficulty picker
 * and a big PLAY. Opened when a song is tapped in the list; this is where the
 * Beatstar "so alive" feeling lives, because the disc and aura finally own the
 * whole screen instead of a corner panel.
 *
 * Everything recolours to the song accent through `accentVars`; the aura picks
 * its style (ember / burst / glow) from that accent on its own.
 */
export function SongHero({
  song,
  accent,
  available,
  difficulty,
  onSelectDifficulty,
  best,
  onPlay,
  onVersus,
  onClose,
  onPrev,
  onNext,
}: SongHeroProps): JSX.Element {
  // Per-run modifiers live here now (the old ready screen's job) so PLAY goes
  // straight into the game. Persisted; PlayScreen reads the same store on start.
  const [mods, setMods] = useState(getStoredModifiers);

  // Play the exit animation before actually unmounting: closing sets this, and
  // `onClose` (the real dismiss) fires when the `hero-out` animation ends — so
  // minimizing slides away instead of vanishing.
  const [closing, setClosing] = useState(false);
  const requestClose = (): void => setClosing(true);

  // Escape closes it, and the arrow keys flip songs — the desktop match for the
  // on-screen prev/next.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestClose();
      else if (e.key === 'ArrowLeft') onPrev();
      else if (e.key === 'ArrowRight') onNext();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onPrev, onNext]);

  return (
    <div
      className={`song-hero ${closing ? 'song-hero--closing' : ''}`}
      style={accentVars(accent)}
      role="dialog"
      aria-label={song.title}
      onAnimationEnd={(e) => {
        // Only an exit animation dismisses — ignore the entrance and per-song
        // swap animations that also bubble here. Two exit names: the full
        // slide, and a plain fade used under reduced motion.
        if (e.animationName === 'hero-out' || e.animationName === 'hero-fade-out') onClose();
      }}
    >
      {/* The song's own art, blurred to a colour wash, plus an accent glow — the
          whole screen takes the song's colour, the way the reference does. */}
      {song.thumbnailUrl && <img className="song-hero__wash" src={song.thumbnailUrl} alt="" aria-hidden />}
      <div className="song-hero__tint" aria-hidden />

      <button type="button" className="song-hero__close" aria-label="Back to songs" onClick={requestClose}>
        <ChevronDown size={26} aria-hidden />
      </button>

      {/* Keyed by song so switching tracks replays the entrance on the title,
          artist and cover — not just the aura. */}
      <div className="song-hero__head song-hero__swap" key={`head-${song.songId}`}>
        <h2 className="song-hero__title">{song.title}</h2>
        <p className="song-hero__artist">{song.artist || 'Unknown artist'}</p>
      </div>

      <div className="song-hero__stage">
        <SongAura className="song-hero__aura" accent={accent} disc={0.66} intensity={0.8} />
        {/* `--art` feeds the blurred colour field behind the cover, so the
            circle carries the song's colour while the frame itself stays whole
            — cropping it to the circle sliced the lettering baked into the art. */}
        <div
          className="song-hero__disc"
          key={song.songId}
          style={
            song.thumbnailUrl
              ? ({ '--art': `url("${song.thumbnailUrl.replace(/"/g, '%22')}")` } as CSSProperties)
              : undefined
          }
        >
          {song.thumbnailUrl ? (
            <img className="song-hero__disc-art" src={song.thumbnailUrl} alt="" />
          ) : (
            <div className="song-hero__disc-art song-hero__disc-art--blank" />
          )}
        </div>
      </div>

      <div className="song-hero__controls rise">
        <div className="difficulty-picker">
          {available.map((name) => (
            <button
              key={name}
              type="button"
              className={`difficulty ${difficulty === name ? 'difficulty--active' : ''} difficulty--${name}`}
              onClick={() => onSelectDifficulty(name)}
            >
              {difficulty === name && <ElectricArcs />}
              <span className="difficulty__name">{name}</span>
            </button>
          ))}
        </div>

        {best && (
          <div className="best-score">
            <span className={`grade grade--${best.grade}`}>{best.grade}</span>
            <div>
              <div className="best-score__value">{best.score.toLocaleString()}</div>
              <div className="muted small">
                {(best.accuracy * 100).toFixed(1)}% · {best.maxCombo}x combo
              </div>
            </div>
          </div>
        )}

        {/* Per-run modifiers, folded in from the old ready screen so PLAY is a
            single step into the game. */}
        <ModifierPanel
          mods={mods}
          onChange={(next) => {
            setMods(next);
            setStoredModifiers(next);
          }}
        />

        <div className="song-hero__play-row">
          <button type="button" className="song-hero__nav" aria-label="Previous song" onClick={onPrev}>
            <SkipBack size={22} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn--primary btn--large menu__play song-hero__play"
            disabled={!difficulty}
            onClick={() => {
              // Unlock audio inside this tap so the run can auto-start with
              // sound and no second "tap to start".
              primeAudio();
              onPlay();
            }}
          >
            {difficulty ? (
              <>
                <ElectricArcs />
                <Play className="menu__play-icon" size={22} aria-hidden />
                Play
              </>
            ) : (
              'No chart'
            )}
          </button>
          <button type="button" className="song-hero__nav" aria-label="Next song" onClick={onNext}>
            <SkipForward size={22} aria-hidden />
          </button>
        </div>

        {/* Versus takes the difficulty already chosen above — both sides play
            the identical chart off one shared clock, so there is nothing else
            to pick. Secondary styling on purpose: solo is the common case, and
            a match needs a second person sitting opposite you. */}
        <button
          type="button"
          className="btn song-hero__versus"
          disabled={!difficulty}
          onClick={() => {
            primeAudio();
            onVersus();
          }}
        >
          <Users size={18} aria-hidden />
          Versus — two players, one phone
        </button>
      </div>
    </div>
  );
}
