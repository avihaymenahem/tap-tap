import { type CSSProperties, type JSX } from 'react';
import { ACHIEVEMENTS } from '../game/achievements.js';
import { getUnlockedAchievements } from '../storage.js';
import { playUiSound } from '../uisfx.js';

/**
 * The trophy case: every badge, earned or not.
 *
 * A locked badge shows its name and how to get it but hides its face behind a
 * lock, so the list doubles as a to-do — you can see what is left to chase. Read
 * once on mount; nothing here changes while it is open.
 */
export function AchievementsScreen({ onBack }: { onBack: () => void }): JSX.Element {
  const unlocked = getUnlockedAchievements();
  const earnedCount = ACHIEVEMENTS.filter((a) => unlocked.has(a.id)).length;

  return (
    <div className="achievements">
      <div className="achievements__card">
        <button
          type="button"
          className="achievements__back"
          onClick={() => {
            playUiSound('back');
            onBack();
          }}
        >
          ‹ Back
        </button>

        <h1>Achievements</h1>
        <p className="achievements__progress">
          {earnedCount} / {ACHIEVEMENTS.length} unlocked
        </p>

        <div className="achievements__grid">
          {ACHIEVEMENTS.map((a, i) => {
            const has = unlocked.has(a.id);
            return (
              <div
                key={a.id}
                className={`ach-card ${has ? 'ach-card--on' : 'ach-card--off'} rise`}
                style={{ '--i': Math.min(i, 12) } as CSSProperties}
              >
                <span className="ach-card__icon" aria-hidden>
                  {has ? a.icon : '🔒'}
                </span>
                <span className="ach-card__name">{a.name}</span>
                <span className="ach-card__desc">{a.description}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
