import prompt from 'custom-electron-prompt';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';

import { sleepTimerService } from './main';
import {
  MAX_FADE_OUT_DURATION_SECONDS,
  MIN_FADE_OUT_DURATION_SECONDS,
  remainingMsToMinutes,
  remainingSongsToNextSongs,
} from './service';

import type { SleepTimerPluginConfig, SleepTimerSnapshot } from './types';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

const PRESET_MINUTES = [15, 30, 45, 60] as const;
const PRESET_SONGS = [1, 2, 3, 4, 5, 8, 10] as const;
const MIN_CUSTOM_MINUTES = 1;
const MAX_CUSTOM_MINUTES = 600;
const MIN_CUSTOM_SONGS = 1;
const MAX_CUSTOM_SONGS = 100;

let subscribedService = null as typeof sleepTimerService;
let unsubscribeRefresh = null as (() => void) | null;

const getSongCountLabel = (nextSongs: number) => {
  if (nextSongs <= 0) {
    return t('plugins.sleep-timer.menu.start-songs.current-song');
  }

  if (nextSongs === 1) {
    return t('plugins.sleep-timer.menu.start-songs.next-song');
  }

  return t('plugins.sleep-timer.menu.start-songs.next-songs', {
    songs: nextSongs,
  });
};

const getStatusLabel = (snapshot: SleepTimerSnapshot) => {
  if (snapshot.mode === 'off' || snapshot.remainingMs === null) {
    if (snapshot.mode !== 'songs-running') {
      return t('plugins.sleep-timer.menu.status.off');
    }
  }

  if (snapshot.mode === 'songs-running' && snapshot.remainingSongs !== null) {
    const nextSongs = remainingSongsToNextSongs(snapshot.remainingSongs);
    if (nextSongs === 0) {
      return t('plugins.sleep-timer.menu.status.songs-current');
    }

    if (nextSongs === 1) {
      return t('plugins.sleep-timer.menu.status.songs-next-song');
    }

    return t('plugins.sleep-timer.menu.status.songs-next-songs', {
      songs: nextSongs,
    });
  }

  if (snapshot.remainingMs === null) {
    return t('plugins.sleep-timer.menu.status.off');
  }

  const minutes = remainingMsToMinutes(snapshot.remainingMs);
  if (snapshot.mode === 'time-paused') {
    return t('plugins.sleep-timer.menu.status.paused', { minutes });
  }

  return t('plugins.sleep-timer.menu.status.running', { minutes });
};

const registerMenuRefresh = (refresh: () => void) => {
  if (!sleepTimerService) {
    unsubscribeRefresh?.();
    subscribedService = null;
    unsubscribeRefresh = null;
    return;
  }

  if (subscribedService === sleepTimerService) {
    return;
  }

  unsubscribeRefresh?.();
  subscribedService = sleepTimerService;
  unsubscribeRefresh = sleepTimerService.onChange(() => {
    Promise.resolve(refresh()).catch((error) => {
      console.error(error);
    });
  });
};

const promptCustomMinutes = async (
  window: Electron.BrowserWindow,
  lastSetMinutes?: number,
) => {
  const output = await prompt(
    {
      title: t('plugins.sleep-timer.menu.custom-minutes.prompt.title'),
      label: t('plugins.sleep-timer.menu.custom-minutes.prompt.label'),
      value: String(lastSetMinutes ?? 30),
      type: 'counter',
      counterOptions: {
        minimum: MIN_CUSTOM_MINUTES,
        maximum: MAX_CUSTOM_MINUTES,
      },
      width: 420,
      ...promptOptions(),
    },
    window,
  );

  const minutes = Number(output);
  if (!Number.isFinite(minutes) || minutes < MIN_CUSTOM_MINUTES) {
    return null;
  }

  return Math.round(minutes);
};

const promptCustomSongs = async (
  window: Electron.BrowserWindow,
  lastSetSongs?: number,
) => {
  const output = await prompt(
    {
      title: t('plugins.sleep-timer.menu.custom-songs.prompt.title'),
      label: t('plugins.sleep-timer.menu.custom-songs.prompt.label'),
      value: String(lastSetSongs ?? 3),
      type: 'counter',
      counterOptions: {
        minimum: MIN_CUSTOM_SONGS,
        maximum: MAX_CUSTOM_SONGS,
      },
      width: 420,
      ...promptOptions(),
    },
    window,
  );

  const songs = Number(output);
  if (!Number.isFinite(songs) || songs < MIN_CUSTOM_SONGS) {
    return null;
  }

  return Math.round(songs);
};

const promptFadeOutDurationSeconds = async (
  window: Electron.BrowserWindow,
  currentSeconds: number,
) => {
  const output = await prompt(
    {
      title: t(
        'plugins.sleep-timer.menu.advanced.fade-out-duration.prompt.title',
      ),
      label: t(
        'plugins.sleep-timer.menu.advanced.fade-out-duration.prompt.label',
      ),
      value: String(currentSeconds),
      type: 'counter',
      counterOptions: {
        minimum: MIN_FADE_OUT_DURATION_SECONDS,
        maximum: MAX_FADE_OUT_DURATION_SECONDS,
      },
      width: 420,
      ...promptOptions(),
    },
    window,
  );

  const seconds = Number(output);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  const roundedSeconds = Math.round(seconds);
  return Math.min(
    MAX_FADE_OUT_DURATION_SECONDS,
    Math.max(MIN_FADE_OUT_DURATION_SECONDS, roundedSeconds),
  );
};

export const onMenu = async ({
  window,
  getConfig,
  setConfig,
  refresh,
}: MenuContext<SleepTimerPluginConfig>): Promise<MenuTemplate> => {
  const config = await getConfig();
  const snapshot = sleepTimerService?.getSnapshot() ?? configToSnapshot(config);

  registerMenuRefresh(refresh);

  return [
    {
      label: getStatusLabel(snapshot),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: t('plugins.sleep-timer.menu.start-time.label'),
      submenu: PRESET_MINUTES.map((minutes) => ({
        label: t('plugins.sleep-timer.menu.start-time.minutes', { minutes }),
        async click() {
          await sleepTimerService?.start(minutes);
          await refresh();
        },
      })),
    },
    {
      label: t('plugins.sleep-timer.menu.start-songs.label'),
      submenu: [
        {
          label: t('plugins.sleep-timer.menu.start-songs.current-song'),
          async click() {
            await sleepTimerService?.startBySongs(0);
            await refresh();
          },
        },
        ...PRESET_SONGS.map((songs) => ({
          label: getSongCountLabel(songs),
          async click() {
            await sleepTimerService?.startBySongs(songs);
            await refresh();
          },
        })),
      ],
    },
    {
      label: t('plugins.sleep-timer.menu.custom-minutes.label'),
      async click() {
        const minutes = await promptCustomMinutes(
          window,
          config.lastSetMinutes,
        );
        if (minutes === null) {
          return;
        }

        await sleepTimerService?.start(minutes);
        await refresh();
      },
    },
    {
      label: t('plugins.sleep-timer.menu.custom-songs.label'),
      async click() {
        const songs = await promptCustomSongs(window, config.lastSetSongs);
        if (songs === null) {
          return;
        }

        await sleepTimerService?.startBySongs(songs);
        await refresh();
      },
    },
    {
      label: t('plugins.sleep-timer.menu.stop'),
      enabled: snapshot.mode !== 'off',
      async click() {
        await sleepTimerService?.stop();
        await refresh();
      },
    },
    { type: 'separator' },
    {
      label: t('plugins.sleep-timer.menu.advanced.label'),
      submenu: [
        {
          label: t('plugins.sleep-timer.menu.advanced.pause-when-paused'),
          type: 'checkbox',
          checked: config.pauseWhenPlaybackPaused,
          click(item) {
            setConfig({ pauseWhenPlaybackPaused: item.checked });
            Promise.resolve(refresh()).catch((error) => {
              console.error(error);
            });
          },
        },
        {
          label: t('plugins.sleep-timer.menu.advanced.fade-out'),
          type: 'checkbox',
          checked: config.fadeOut.enabled,
          click(item) {
            setConfig({
              fadeOut: {
                ...config.fadeOut,
                enabled: item.checked,
              },
            });
            Promise.resolve(refresh()).catch((error) => {
              console.error(error);
            });
          },
        },
        {
          label: t(
            'plugins.sleep-timer.menu.advanced.fade-out-duration.label',
            {
              seconds: config.fadeOut.durationSeconds,
            },
          ),
          async click() {
            const seconds = await promptFadeOutDurationSeconds(
              window,
              config.fadeOut.durationSeconds,
            );
            if (seconds === null) {
              return;
            }

            await setConfig({
              fadeOut: {
                ...config.fadeOut,
                durationSeconds: seconds,
              },
            });

            await refresh();
          },
        },
      ],
    },
  ];
};

const configToSnapshot = (
  config: SleepTimerPluginConfig,
): SleepTimerSnapshot => {
  if (config.timer.mode === 'off') {
    return {
      mode: 'off',
      remainingMs: null,
      remainingSongs: null,
    };
  }

  if (config.timer.mode === 'songs-running') {
    return {
      mode: 'songs-running',
      remainingMs: null,
      remainingSongs: config.timer.remainingSongs,
    };
  }

  if (config.timer.mode === 'time-paused') {
    return {
      mode: 'time-paused',
      remainingMs: Math.max(0, config.timer.remainingMs),
      remainingSongs: null,
    };
  }

  return {
    mode: 'time-running',
    remainingMs: Math.max(0, config.timer.endAtMs - Date.now()),
    remainingSongs: null,
  };
};
