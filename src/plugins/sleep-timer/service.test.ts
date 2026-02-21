import { expect, test } from '@playwright/test';

import { SleepTimerService } from './service';

import type { SleepTimerPluginConfig } from './types';

const createConfig = (): SleepTimerPluginConfig => ({
  enabled: true,
  expiryAction: 'pause',
  pauseWhenPlaybackPaused: false,
  fadeOut: {
    enabled: false,
    durationSeconds: 10,
  },
  timer: {
    mode: 'off',
  },
  lastSetMinutes: 30,
  lastSetSongs: 3,
});

const createService = () => {
  let currentConfig = createConfig();
  let pauseCalls = 0;
  let volume = 100;

  const service = new SleepTimerService({
    initialConfig: currentConfig,
    setConfig: (patch) => {
      currentConfig = {
        ...currentConfig,
        ...patch,
      };
    },
    pausePlayback: () => {
      pauseCalls += 1;
    },
    setVolume: (nextVolume) => {
      volume = nextVolume;
    },
    getCurrentVolume: () => volume,
  });

  return {
    service,
    getPauseCalls: () => pauseCalls,
    getConfig: () => currentConfig,
  };
};

test('expires when paused at natural end for end of current song', async () => {
  const { service, getPauseCalls } = createService();

  await service.startBySongs(0);
  await service.onSongEvent('track-a', false, 120, 180, false);
  await service.onSongEvent('track-a', false, 179.9, 180, true);

  expect(service.getSnapshot().mode).toBe('off');
  expect(getPauseCalls()).toBe(1);
  service.destroy();
});

test('does not double decrement on duplicate video-src change events', async () => {
  const { service } = createService();

  await service.startBySongs(2);
  await service.onSongEvent('track-a', false, 0, 180, false);
  await service.onSongEvent('track-b', true, 0, 180, false);
  await service.onSongEvent('track-b', true, 1, 180, false);

  expect(service.getSnapshot().mode).toBe('songs-running');
  expect(service.getSnapshot().remainingSongs).toBe(2);
  service.destroy();
});

test('consumes song boundary on same video id rollover', async () => {
  const { service, getConfig } = createService();

  await service.startBySongs(1);
  await service.onSongEvent('loop-track', false, 170, 172, false);
  await service.onSongEvent('loop-track', false, 0.2, 172, false);

  expect(service.getSnapshot().mode).toBe('songs-running');
  expect(service.getSnapshot().remainingSongs).toBe(1);
  expect(getConfig().timer).toStrictEqual({
    mode: 'songs-running',
    remainingSongs: 1,
  });
  service.destroy();
});
