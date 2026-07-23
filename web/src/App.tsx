import { useEffect, useRef, useState, type JSX } from 'react';
import { RetroBackdrop } from './components/RetroBackdrop.js';
import type { RunResult } from './game/run.js';
import { loadRun, saveRun } from './lastRun.js';
import { getTutorialSeen, recordRunAchievements } from './storage.js';
import { useAndroidBackButton } from './hooks/useAndroidBackButton.js';
import { useSharedLink } from './hooks/useSharedLink.js';
import { useRouter } from './router.js';
import { AdminScreen } from './screens/AdminScreen.js';
import { ThemesScreen } from './screens/ThemesScreen.js';
import { AchievementsScreen } from './screens/AchievementsScreen.js';
import { CalibrationScreen } from './screens/CalibrationScreen.js';
import { EditorScreen } from './screens/EditorScreen.js';
import { MenuScreen } from './screens/MenuScreen.js';
import { PlayScreen } from './screens/PlayScreen.js';
import { VersusPlayScreen } from './screens/VersusPlayScreen.js';
import { ResultsScreen } from './screens/ResultsScreen.js';
import { TutorialScreen } from './screens/TutorialScreen.js';

export function App(): JSX.Element {
  const { route, navigate } = useRouter();

  // Android hardware back is route-aware: it mirrors each screen's own back/exit
  // and always lands on a stable parent, never on a transient run or its results
  // (which is where a raw history.back() would strand the player). Returning
  // false means "nowhere back to" and the hook exits the app.
  useAndroidBackButton(() => {
    switch (route.name) {
      case 'menu':
        return false; // home — the only place back exits the app
      case 'themes':
        navigate({ name: 'admin' }, { replace: true });
        return true;
      case 'play':
      case 'versus':
      case 'results':
      case 'edit':
      case 'calibrate':
      case 'achievements':
      case 'tutorial':
      case 'admin':
        navigate({ name: 'menu' }, { replace: true });
        return true;
    }
  });

  // First launch: send a new player through the tutorial before the menu. Only
  // from the menu route (a deep link to anywhere else is honoured), and once —
  // the tutorial sets the seen flag on start/skip/finish.
  useEffect(() => {
    if (route.name === 'menu' && !getTutorialSeen()) {
      navigate({ name: 'tutorial' }, { replace: true });
    }
    // Intentionally only on mount: this is a first-launch redirect, not a guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A YouTube link shared into the app: route to the menu and hand the URL to it,
  // where it opens the Add-a-song dialog prefilled.
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  useSharedLink((url) => {
    setSharedUrl(url);
    navigate({ name: 'menu' });
  });

  /**
   * Title of the chart currently being played, captured when a run finishes.
   * The URL carries only ids, and the results screen wants a human name.
   */
  const titleRef = useRef('');

  const onFinish = (result: RunResult, accent: number): void => {
    if (route.name !== 'play') return;
    // Record achievements exactly once, here — not in the results screen, which
    // can re-mount and would double-count the run. The freshly earned badges
    // ride along on the stored run so results can celebrate them.
    const earned = recordRunAchievements(route.songId, route.difficulty, result);
    saveRun({
      ...result,
      songId: route.songId,
      difficulty: route.difficulty,
      title: titleRef.current,
      accent,
      newAchievements: earned.map((a) => a.id),
    });
    // Replace, not push: pressing Back from the results screen should return to
    // the song list, not drop the player into another run of the same chart.
    navigate(
      { name: 'results', songId: route.songId, difficulty: route.difficulty },
      { replace: true },
    );
  };

  const screen = (): JSX.Element => {
    switch (route.name) {
      case 'play':
        return (
          <PlayScreen
            // Remount on chart change so a fresh run never inherits engine state.
            key={`${route.songId}:${route.difficulty}`}
            songId={route.songId}
            difficulty={route.difficulty}
            onTitle={(title) => {
              titleRef.current = title;
            }}
            onExit={() => navigate({ name: 'menu' })}
            onFinish={onFinish}
          />
        );

      case 'versus':
        return (
          <VersusPlayScreen
            key={`${route.songId}:${route.difficulty}`}
            songId={route.songId}
            difficulty={route.difficulty}
            onExit={() => navigate({ name: 'menu' })}
          />
        );

      case 'results':
        return (
          <ResultsScreen
            songId={route.songId}
            difficulty={route.difficulty}
            onRetry={() =>
              // Replace, not push: a retry supersedes the results it came from,
              // so Back from the new run returns to the song list — never to a
              // stale results card, and never back into the finished run.
              navigate(
                { name: 'play', songId: route.songId, difficulty: route.difficulty },
                { replace: true },
              )
            }
            onMenu={() => navigate({ name: 'menu' })}
            onMissing={() => navigate({ name: 'menu' }, { replace: true })}
          />
        );

      case 'edit':
        return (
          <EditorScreen
            key={`${route.songId}:${route.difficulty}`}
            songId={route.songId}
            difficulty={route.difficulty}
            onExit={() => navigate({ name: 'menu' })}
            onChangeDifficulty={(difficulty) =>
              navigate({ name: 'edit', songId: route.songId, difficulty }, { replace: true })
            }
          />
        );

      case 'calibrate':
        return <CalibrationScreen onDone={() => navigate({ name: 'menu' })} />;

      case 'achievements':
        return <AchievementsScreen onBack={() => navigate({ name: 'menu' })} />;

      case 'tutorial':
        return (
          <TutorialScreen
            onDone={() => navigate({ name: 'menu' }, { replace: true })}
            onCalibrate={() => navigate({ name: 'calibrate' }, { replace: true })}
          />
        );

      case 'admin':
        return (
          <AdminScreen
            onBack={() => navigate({ name: 'menu' })}
            onEdit={(songId) => navigate({ name: 'edit', songId, difficulty: 'medium' })}
            onThemes={() => navigate({ name: 'themes' })}
          />
        );
      case 'themes':
        return <ThemesScreen onBack={() => navigate({ name: 'admin' })} />;

      case 'menu':
        return (
          <MenuScreen
            onPlay={(songId, difficulty) => navigate({ name: 'play', songId, difficulty })}
            onAdmin={() => navigate({ name: 'admin' })}
            onCalibrate={() => navigate({ name: 'calibrate' })}
            onAchievements={() => navigate({ name: 'achievements' })}
            onHowToPlay={() => navigate({ name: 'tutorial' })}
            sharedUrl={sharedUrl}
            onShareConsumed={() => setSharedUrl(null)}
          />
        );
    }
  };

  return (
    <>
      {/* The play screen paints its own sunset in three.js, and the editor is a
          workspace rather than a place — neither wants a second one behind it.
          The themes screen is excluded for the first reason: its preview canvas
          is a live highway, and two suns on screen read as a rendering fault. */}
      {route.name !== 'play' &&
        route.name !== 'versus' &&
        route.name !== 'tutorial' &&
        route.name !== 'edit' &&
        route.name !== 'themes' && (
        <RetroBackdrop
          dim={route.name === 'admin'}
          // Only the results screen tints the backdrop, to the finished run's
          // accent, so the light behind the card matches it. The menu is left on
          // the default gold on purpose: it lists every song, so tinting to the
          // current selection made the glow lurch between colours as you browse
          // and mixed badly with the warm stage. The detail panel still carries
          // the selected song's accent — that stays contained to the panel.
          accent={
            route.name === 'results'
              ? loadRun(route.songId, route.difficulty)?.accent
              : undefined
          }
        />
      )}
      {/* Keyed by route so every navigation replays the entrance. Play is
          unwrapped: its canvas manages its own phases and must never fade. */}
      {route.name === 'play' || route.name === 'versus' || route.name === 'tutorial' ? (
        screen()
      ) : (
        <div className="screen" key={route.name}>
          {screen()}
        </div>
      )}
    </>
  );
}
