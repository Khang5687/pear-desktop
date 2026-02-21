import { Menu, nativeImage, screen, Tray } from 'electron';
import is from 'electron-is';

import TrayIcon from '@assets/tray.png?asset&asarUnpack';
import PausedTrayIcon from '@assets/tray-paused.png?asset&asarUnpack';
import TrayIconWhite from '@assets/tray-white.png?asset&asarUnpack';
import PausedTrayIconWhite from '@assets/tray-paused-white.png?asset&asarUnpack';
import { sleepTimerService } from '@/plugins/sleep-timer/main';
import {
  remainingMsToMinutes,
  remainingSongsToNextSongs,
} from '@/plugins/sleep-timer/service';

import * as config from './config';

import { restart } from './providers/app-controls';
import { registerCallback, SongInfoEvent } from './providers/song-info';
import { getSongControls } from './providers/song-controls';

import { APPLICATION_NAME, t } from '@/i18n';

import type { MenuTemplate } from './menu';

// Prevent tray being garbage collected
let tray: Electron.Tray | undefined;
let trayApp: Electron.App | null = null;
let trayWindow: Electron.BrowserWindow | null = null;
let subscribedSleepTimerService = null as typeof sleepTimerService;
let unsubscribeSleepTimerChange = null as (() => void) | null;

type TrayEvent = (
  event: Electron.KeyboardEvent,
  bounds: Electron.Rectangle,
) => void;

const PRESET_MINUTES = [15, 30, 45, 60] as const;
const PRESET_SONGS = [1, 2, 3, 4, 5, 8, 10] as const;

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

const sleepTimerPluginEnabled = () => {
  const pluginConfig = config.get('plugins.sleep-timer') as
    | { enabled?: boolean }
    | undefined;

  return Boolean(pluginConfig?.enabled);
};

const getSleepTimerStatusLabel = () => {
  const snapshot = sleepTimerService?.getSnapshot();
  if (!snapshot || snapshot.mode === 'off') {
    return t('plugins.sleep-timer.tray.status.off');
  }

  if (snapshot.mode === 'songs-running' && snapshot.remainingSongs !== null) {
    const nextSongs = remainingSongsToNextSongs(snapshot.remainingSongs);
    if (nextSongs === 0) {
      return t('plugins.sleep-timer.tray.status.songs-current');
    }

    if (nextSongs === 1) {
      return t('plugins.sleep-timer.tray.status.songs-next-song');
    }

    return t('plugins.sleep-timer.tray.status.songs-next-songs', {
      songs: nextSongs,
    });
  }

  if (snapshot.remainingMs === null) {
    return t('plugins.sleep-timer.tray.status.off');
  }

  const minutes = remainingMsToMinutes(snapshot.remainingMs);
  if (snapshot.mode === 'time-paused') {
    return t('plugins.sleep-timer.tray.status.paused', { minutes });
  }

  return t('plugins.sleep-timer.tray.status.running', { minutes });
};

const getSleepTimerMenuTemplate = (): Electron.MenuItemConstructorOptions => {
  if (!sleepTimerPluginEnabled()) {
    return {
      label: t('plugins.sleep-timer.tray.label'),
      submenu: [
        {
          label: t('plugins.sleep-timer.tray.enable-plugin'),
          enabled: false,
        },
      ],
    };
  }

  const snapshot = sleepTimerService?.getSnapshot();

  return {
    label: t('plugins.sleep-timer.tray.label'),
    submenu: [
      {
        label: getSleepTimerStatusLabel(),
        enabled: false,
      },
      { type: 'separator' },
      {
        label: t('plugins.sleep-timer.tray.start-time.label'),
        submenu: PRESET_MINUTES.map((minutes) => ({
          label: t('plugins.sleep-timer.menu.start-time.minutes', { minutes }),
          async click() {
            await sleepTimerService?.start(minutes);
          },
        })),
      },
      {
        label: t('plugins.sleep-timer.tray.start-songs.label'),
        submenu: [
          {
            label: t('plugins.sleep-timer.menu.start-songs.current-song'),
            async click() {
              await sleepTimerService?.startBySongs(0);
            },
          },
          ...PRESET_SONGS.map((songs) => ({
            label: getSongCountLabel(songs),
            async click() {
              await sleepTimerService?.startBySongs(songs);
            },
          })),
        ],
      },
      { type: 'separator' },
      {
        label: t('plugins.sleep-timer.tray.stop'),
        enabled: snapshot?.mode !== 'off',
        async click() {
          await sleepTimerService?.stop();
        },
      },
    ],
  };
};

const buildTrayMenuTemplate = (
  app: Electron.App,
  win: Electron.BrowserWindow,
  controls: ReturnType<typeof getSongControls>,
): MenuTemplate => [
  {
    label: t('main.tray.play-pause'),
    click() {
      controls.playPause();
    },
  },
  {
    label: t('main.tray.next'),
    click() {
      controls.next();
    },
  },
  {
    label: t('main.tray.previous'),
    click() {
      controls.previous();
    },
  },
  getSleepTimerMenuTemplate(),
  { type: 'separator' },
  {
    label: t('main.tray.show'),
    click() {
      win.show();
      app.dock?.show();
    },
  },
  { type: 'separator' },
  {
    label: t('main.tray.restart'),
    click: restart,
  },
  { type: 'separator' },
  {
    label: t('main.tray.quit'),
    role: 'quit',
  },
];

const syncSleepTimerTrayRefresh = () => {
  if (subscribedSleepTimerService === sleepTimerService) {
    return;
  }

  unsubscribeSleepTimerChange?.();
  unsubscribeSleepTimerChange = null;
  subscribedSleepTimerService = sleepTimerService;

  if (sleepTimerService) {
    unsubscribeSleepTimerChange = sleepTimerService.onChange(() => {
      refreshTrayMenu();
    });
  }
};

export const refreshTrayMenu = () => {
  if (!tray || !trayApp || !trayWindow) {
    return;
  }

  syncSleepTimerTrayRefresh();
  const controls = getSongControls(trayWindow);
  const trayMenu = Menu.buildFromTemplate(
    buildTrayMenuTemplate(trayApp, trayWindow, controls),
  );
  tray.setContextMenu(trayMenu);
};

export const setTrayOnClick = (fn: TrayEvent) => {
  if (!tray) {
    return;
  }

  tray.removeAllListeners('click');
  tray.on('click', fn);
};

// Won't do anything on macOS since its disabled
export const setTrayOnDoubleClick = (fn: TrayEvent) => {
  if (!tray) {
    return;
  }

  tray.removeAllListeners('double-click');
  tray.on('double-click', fn);
};

export const setUpTray = (app: Electron.App, win: Electron.BrowserWindow) => {
  if (!config.get('options.tray')) {
    unsubscribeSleepTimerChange?.();
    unsubscribeSleepTimerChange = null;
    subscribedSleepTimerService = null;
    tray?.destroy();
    tray = undefined;
    trayApp = null;
    trayWindow = null;
    return;
  }

  const { playPause } = getSongControls(win);

  const pixelRatio = is.windows()
    ? screen.getPrimaryDisplay().scaleFactor || 1
    : 1;

  const defaultTrayIcon = nativeImage
    .createFromPath(is.macOS() ? TrayIconWhite : TrayIcon)
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });
  const pausedTrayIcon = nativeImage
    .createFromPath(is.macOS() ? PausedTrayIconWhite : PausedTrayIcon)
    .resize({
      width: 16 * pixelRatio,
      height: 16 * pixelRatio,
    });

  tray?.destroy();
  tray = new Tray(defaultTrayIcon);
  trayApp = app;
  trayWindow = win;

  tray.setToolTip(
    t('main.tray.tooltip.default', {
      applicationName: APPLICATION_NAME,
    }),
  );

  // MacOS only
  tray.setIgnoreDoubleClickEvents(true);

  tray.on('click', () => {
    if (config.get('options.trayClickPlayPause')) {
      playPause();
    } else if (win.isVisible()) {
      win.hide();
      app.dock?.hide();
    } else {
      win.show();
      app.dock?.show();
    }
  });

  refreshTrayMenu();

  registerCallback((songInfo, event) => {
    if (event === SongInfoEvent.TimeChanged) return;

    if (tray) {
      if (typeof songInfo.isPaused === 'undefined') {
        tray.setImage(defaultTrayIcon);
        return;
      }

      tray.setToolTip(
        t('main.tray.tooltip.with-song-info', {
          artist: songInfo.artist,
          title: songInfo.title,
          applicationName: APPLICATION_NAME,
        }),
      );

      tray.setImage(songInfo.isPaused ? pausedTrayIcon : defaultTrayIcon);
    }
  });
};
