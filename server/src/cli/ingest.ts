/**
 * Ingest a song from the command line.
 *
 *   npm run ingest -w server -- "https://www.youtube.com/watch?v=..."
 */

import { DIFFICULTY_NAMES } from '@tap-tap/shared';
import { ingestSong } from '../ingest/pipeline.js';

const url = process.argv[2];

if (!url) {
  console.error('usage: npm run ingest -w server -- <youtube-url-or-id>');
  process.exit(1);
}

const started = Date.now();

try {
  const beatmap = await ingestSong(url, (status, message) => {
    console.log(`  [${status}] ${message}`);
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(`  ${beatmap.title}`);
  console.log(`  ${beatmap.artist}`);
  console.log('');
  console.log(`  duration    ${beatmap.duration.toFixed(1)}s`);
  console.log(`  bpm         ${beatmap.bpm} (confidence ${beatmap.bpmConfidence})`);
  console.log(`  beats       ${beatmap.beatGrid.length}`);
  for (const name of DIFFICULTY_NAMES) {
    const chart = beatmap.charts[name];
    const nps = (chart.notes.length / beatmap.duration).toFixed(2);
    console.log(`  ${name.padEnd(11)} ${String(chart.notes.length).padStart(5)} notes  ${nps} notes/sec  ${chart.laneCount} lanes`);
  }
  console.log('');
  console.log(`  done in ${elapsed}s`);
} catch (error) {
  console.error('');
  console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
