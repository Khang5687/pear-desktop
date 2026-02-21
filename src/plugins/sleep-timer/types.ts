import type { PluginConfig } from '@/types/plugins';

export type SleepTimerExpiryAction = 'pause';

export interface SleepTimerFadeOutConfig {
  enabled: boolean;
  durationSeconds: number;
}

export type SleepTimerState =
  | { mode: 'off' }
  | { mode: 'time-running'; endAtMs: number }
  | { mode: 'time-paused'; remainingMs: number }
  | { mode: 'songs-running'; remainingSongs: number };

export interface SleepTimerPluginConfig extends PluginConfig {
  expiryAction: SleepTimerExpiryAction;
  pauseWhenPlaybackPaused: boolean;
  fadeOut: SleepTimerFadeOutConfig;
  timer: SleepTimerState;
  lastSetMinutes?: number;
  lastSetSongs?: number;
}

export interface SleepTimerSnapshot {
  mode: SleepTimerState['mode'];
  remainingMs: number | null;
  remainingSongs: number | null;
}
