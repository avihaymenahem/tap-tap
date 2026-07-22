import { useRef, type JSX } from 'react';
import { RetroBackdrop } from './components/RetroBackdrop.js';
import type { RunResult } from './game/run.js';
import { saveRun } from './lastRun.js';
import { useRouter } from './router.js';
import { AdminScreen } from './screens/AdminScreen.js';
import { ThemesScreen } from './screens/ThemesScreen.js';
import { CalibrationScreen } from './screens/CalibrationScreen.js';
import { EditorScreen } from './screens/EditorScreen.js';
import { MenuScreen } from './screens/MenuScreen.js';
import { PlayScreen } from './screens/PlayScreen.js';
import { ResultsScreen } from './screens/ResultsScreen.js';

export function App(): JSX.Element {
  const { route, navigate } = useRouter();

  /**
   * Title of the chart currently being played, captured when a run finishes.
   * The URL carries only ids, and the results screen wants a human name.
   */
  const titleRef = useRef('');

  const onFinish = (result: RunResult, accent: number): void => {
    if (route.name !== 'play') return;
    saveRun({
      ...result,
      songId: route.songId,
      difficulty: route.difficulty,
      title: titleRef.current,
      accent,
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

      case 'results':
        return (
          <ResultsScreen
            songId={route.songId}
            difficulty={route.difficulty}
            onRetry={() =>
              navigate({ name: 'play', songId: route.songId, difficulty: route.difficulty })
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
      {route.name !== 'play' && route.name !== 'edit' && route.name !== 'themes' && (
        <RetroBackdrop dim={route.name === 'admin'} />
      )}
      {/* Keyed by route so every navigation replays the entrance. Play is
          unwrapped: its canvas manages its own phases and must never fade. */}
      {route.name === 'play' ? (
        screen()
      ) : (
        <div className="screen" key={route.name}>
          {screen()}
        </div>
      )}
    </>
  );
}
