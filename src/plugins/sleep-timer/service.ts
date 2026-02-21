import type { SleepTimerPluginConfig, SleepTimerSnapshot } from './types';

const MINUTE_MS = 60_000;
const CHANGE_TICK_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_000_000;
const FADE_STEP_MS = 200;

export const MIN_FADE_OUT_DURATION_SECONDS = 3;
export const MAX_FADE_OUT_DURATION_SECONDS = 120;

type SleepTimerPatch = Partial<Omit<SleepTimerPluginConfig, 'enabled'>>;
type ExpireSource = 'time' | 'songs';

interface SleepTimerServiceOptions {
  initialConfig: SleepTimerPluginConfig;
  setConfig: (config: SleepTimerPatch) => Promise<void> | void;
  pausePlayback: () => void;
  setVolume: (volume: number) => void;
  getCurrentVolume: () => number;
}

export const remainingMsToMinutes = (remainingMs: number) =>
  Math.max(1, Math.ceil(remainingMs / MINUTE_MS));

export const remainingSongsToNextSongs = (remainingSongs: number) =>
  Math.max(0, remainingSongs - 1);

export class SleepTimerService {
  private config: SleepTimerPluginConfig;
  private expiryTimeout: NodeJS.Timeout | null = null;
  private changeTicker: NodeJS.Timeout | null = null;
  private fadeStartTimeout: NodeJS.Timeout | null = null;
  private fadeStepInterval: NodeJS.Timeout | null = null;
  private readonly changeCallbacks = new Set<() => void>();
  private readonly setConfig: (config: SleepTimerPatch) => Promise<void> | void;
  private readonly pausePlayback: () => void;
  private readonly setVolume: (volume: number) => void;
  private readonly getCurrentVolume: () => number;
  private playerApiReady = false;
  private pendingPausePlayback = false;
  private expiring = false;
  private fadeRestoreVolume: number | null = null;
  private fadeState: { startAtMs: number; durationMs: number } | null = null;
  private currentVideoId: string | null = null;
  private songModeLastCountedVideoId: string | null = null;

  constructor({
    initialConfig,
    setConfig,
    pausePlayback,
    setVolume,
    getCurrentVolume,
  }: SleepTimerServiceOptions) {
    this.config = this.normalizeConfig(initialConfig);
    this.setConfig = setConfig;
    this.pausePlayback = pausePlayback;
    this.setVolume = setVolume;
    this.getCurrentVolume = getCurrentVolume;
  }

  async applyConfig(newConfig: SleepTimerPluginConfig) {
    this.config = this.normalizeConfig(newConfig);

    if (this.config.timer.mode !== 'songs-running') {
      this.songModeLastCountedVideoId = null;
    } else if (!this.songModeLastCountedVideoId) {
      this.songModeLastCountedVideoId = this.currentVideoId;
    }

    await this.reconcileTimers();
    this.emitChange();
  }

  getSnapshot(now = Date.now()): SleepTimerSnapshot {
    const mode = this.config.timer.mode;
    return {
      mode,
      remainingMs: this.getRemainingMs(now),
      remainingSongs:
        mode === 'songs-running' ? this.config.timer.remainingSongs : null,
    };
  }

  async start(minutes: number) {
    const safeMinutes = Math.max(1, Math.round(minutes));
    const durationMs = safeMinutes * MINUTE_MS;
    const endAtMs = Date.now() + durationMs;

    this.songModeLastCountedVideoId = null;
    this.stopFadeAndRestore();

    await this.persistConfig({
      timer: {
        mode: 'time-running',
        endAtMs,
      },
      lastSetMinutes: safeMinutes,
    });

    await this.reconcileTimers();
    this.emitChange();
  }

  async startBySongs(nextSongCount: number) {
    const safeNextSongCount = Math.max(0, Math.round(nextSongCount));
    const internalSongCount = safeNextSongCount + 1;

    this.stopFadeAndRestore();
    this.songModeLastCountedVideoId = this.currentVideoId;

    await this.persistConfig({
      timer: {
        mode: 'songs-running',
        remainingSongs: internalSongCount,
      },
      lastSetSongs: Math.max(1, safeNextSongCount),
    });

    await this.reconcileTimers();
    this.emitChange();
  }

  async stop() {
    if (this.config.timer.mode === 'off') {
      return;
    }

    this.songModeLastCountedVideoId = null;
    this.stopFadeAndRestore();

    await this.persistConfig({
      timer: {
        mode: 'off',
      },
    });

    await this.reconcileTimers();
    this.emitChange();
  }

  onSuspend() {
    this.clearFadeStartTimeout();
  }

  async onResume() {
    await this.reconcileTimers();
    this.emitChange();
  }

  async setPlaybackPaused(isPaused: boolean) {
    if (!this.config.pauseWhenPlaybackPaused) {
      return;
    }

    if (isPaused && this.config.timer.mode === 'time-running') {
      const remainingMs = this.getRemainingMs(Date.now());
      if (remainingMs === null) {
        return;
      }

      if (remainingMs <= 0) {
        await this.expireTimer('time');
        return;
      }

      await this.persistConfig({
        timer: {
          mode: 'time-paused',
          remainingMs,
        },
      });
      await this.reconcileTimers();
      this.emitChange();
      return;
    }

    if (!isPaused && this.config.timer.mode === 'time-paused') {
      const remainingMs = Math.max(0, this.config.timer.remainingMs);
      if (remainingMs <= 0) {
        await this.expireTimer('time');
        return;
      }

      await this.persistConfig({
        timer: {
          mode: 'time-running',
          endAtMs: Date.now() + remainingMs,
        },
      });

      await this.reconcileTimers();
      this.emitChange();
    }
  }

  async onSongEvent(videoId: string | undefined, isTrackChange: boolean) {
    if (!videoId) {
      return;
    }

    this.currentVideoId = videoId;

    if (this.config.timer.mode !== 'songs-running') {
      return;
    }

    if (!this.songModeLastCountedVideoId) {
      this.songModeLastCountedVideoId = videoId;
      return;
    }

    if (!isTrackChange) {
      return;
    }

    this.songModeLastCountedVideoId = videoId;

    const remainingSongs = this.config.timer.remainingSongs - 1;
    if (remainingSongs <= 0) {
      await this.expireTimer('songs');
      return;
    }

    await this.persistConfig({
      timer: {
        mode: 'songs-running',
        remainingSongs,
      },
    });

    this.emitChange();
  }

  onPlayerApiReady() {
    this.playerApiReady = true;

    if (this.pendingPausePlayback) {
      this.pausePlayback();
      this.pendingPausePlayback = false;
    }
  }

  onChange(callback: () => void) {
    this.changeCallbacks.add(callback);

    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  destroy() {
    this.clearExpiryTimeout();
    this.clearChangeTicker();
    this.stopFadeAndRestore();
    this.changeCallbacks.clear();
  }

  private async persistConfig(patch: SleepTimerPatch) {
    this.config = this.normalizeConfig({
      ...this.config,
      ...patch,
    });
    await this.setConfig(patch);
  }

  private async reconcileTimers() {
    this.clearExpiryTimeout();
    this.clearFadeStartTimeout();
    this.syncChangeTicker();

    if (this.config.timer.mode === 'time-running') {
      const remainingMs = this.getRemainingMs(Date.now());
      if (remainingMs === null) {
        return;
      }

      if (remainingMs <= 0) {
        await this.expireTimer('time');
        return;
      }

      this.syncFadeForTimeMode(remainingMs);
      this.scheduleExpiryTimeout(remainingMs);
      return;
    }

    this.stopFadeAndRestore();

    if (this.config.timer.mode === 'songs-running') {
      if (!this.songModeLastCountedVideoId) {
        this.songModeLastCountedVideoId = this.currentVideoId;
      }
      return;
    }

    this.songModeLastCountedVideoId = null;
  }

  private getRemainingMs(now: number) {
    const { timer } = this.config;
    if (timer.mode === 'off' || timer.mode === 'songs-running') {
      return null;
    }

    if (timer.mode === 'time-paused') {
      return Math.max(0, timer.remainingMs);
    }

    return Math.max(0, timer.endAtMs - now);
  }

  private scheduleExpiryTimeout(delayMs: number) {
    this.expiryTimeout = setTimeout(
      () => {
        this.handleExpiryTimeout().catch((error) => {
          console.error(error);
        });
      },
      Math.min(delayMs, MAX_TIMEOUT_MS),
    );
  }

  private scheduleFadeStartTimeout(delayMs: number) {
    this.fadeStartTimeout = setTimeout(
      () => {
        this.handleFadeStartTimeout();
      },
      Math.min(delayMs, MAX_TIMEOUT_MS),
    );
  }

  private async handleExpiryTimeout() {
    if (this.config.timer.mode !== 'time-running') {
      return;
    }

    const remainingMs = this.getRemainingMs(Date.now());
    if (remainingMs === null) {
      return;
    }

    if (remainingMs <= 0) {
      await this.expireTimer('time');
      return;
    }

    this.scheduleExpiryTimeout(remainingMs);
    this.emitChange();
  }

  private handleFadeStartTimeout() {
    if (
      this.config.timer.mode !== 'time-running' ||
      !this.config.fadeOut.enabled
    ) {
      return;
    }

    const remainingMs = this.getRemainingMs(Date.now());
    if (remainingMs === null || remainingMs <= 0) {
      return;
    }

    const fadeDurationMs = this.getFadeDurationMs();
    if (remainingMs > fadeDurationMs) {
      this.scheduleFadeStartTimeout(remainingMs - fadeDurationMs);
      return;
    }

    this.startFade(remainingMs);
    this.emitChange();
  }

  private async expireTimer(source: ExpireSource) {
    const mode = this.config.timer.mode;
    if (this.expiring || mode === 'off') {
      return;
    }

    this.expiring = true;
    this.clearExpiryTimeout();
    this.clearChangeTicker();
    this.clearFadeStartTimeout();

    const restoreVolume = this.fadeRestoreVolume;
    this.stopFade(false);

    try {
      if (source === 'songs') {
        await this.runImmediateFadeIfEnabled();
      }

      this.pausePlayback();
      if (!this.playerApiReady) {
        this.pendingPausePlayback = true;
      }

      if (restoreVolume !== null) {
        this.setVolume(restoreVolume);
      } else if (this.fadeRestoreVolume !== null) {
        this.setVolume(this.fadeRestoreVolume);
      }

      this.songModeLastCountedVideoId = null;

      await this.persistConfig({
        timer: {
          mode: 'off',
        },
      });
    } finally {
      this.stopFade(false);
      this.expiring = false;
      this.emitChange();
    }
  }

  private syncFadeForTimeMode(remainingMs: number) {
    if (!this.config.fadeOut.enabled) {
      this.stopFadeAndRestore();
      return;
    }

    const fadeDurationMs = this.getFadeDurationMs();
    if (remainingMs <= fadeDurationMs) {
      this.startFade(remainingMs);
      return;
    }

    this.stopFadeAndRestore();
    this.scheduleFadeStartTimeout(remainingMs - fadeDurationMs);
  }

  private startFade(remainingMs: number) {
    if (this.fadeState) {
      return;
    }

    const durationMs = Math.max(
      FADE_STEP_MS,
      Math.min(remainingMs, this.getFadeDurationMs()),
    );
    const currentVolume = this.normalizeVolume(this.getCurrentVolume());

    if (currentVolume <= 0) {
      this.stopFade(false);
      return;
    }

    this.stopFade(false);
    this.fadeRestoreVolume = currentVolume;
    this.fadeState = {
      startAtMs: Date.now(),
      durationMs,
    };

    this.applyFadeVolume();
    this.fadeStepInterval = setInterval(() => {
      this.applyFadeVolume();
    }, FADE_STEP_MS);
  }

  private applyFadeVolume() {
    if (!this.fadeState || this.fadeRestoreVolume === null) {
      return;
    }

    const elapsedMs = Date.now() - this.fadeState.startAtMs;
    const progress = Math.min(1, elapsedMs / this.fadeState.durationMs);
    const volume = this.normalizeVolume(
      Math.round(this.fadeRestoreVolume * (1 - progress)),
    );

    this.setVolume(volume);

    if (progress >= 1) {
      this.clearFadeStepInterval();
      this.fadeState = null;
    }
  }

  private async runImmediateFadeIfEnabled() {
    if (!this.config.fadeOut.enabled) {
      return;
    }

    const durationMs = this.getFadeDurationMs();
    const startVolume = this.normalizeVolume(this.getCurrentVolume());
    if (durationMs <= 0 || startVolume <= 0) {
      return;
    }

    this.stopFade(false);
    this.fadeRestoreVolume = startVolume;
    this.fadeState = {
      startAtMs: Date.now(),
      durationMs,
    };

    await new Promise<void>((resolve) => {
      this.applyFadeVolume();
      this.fadeStepInterval = setInterval(() => {
        this.applyFadeVolume();
        if (!this.fadeState) {
          resolve();
        }
      }, FADE_STEP_MS);
    });
  }

  private stopFadeAndRestore() {
    const restoreVolume = this.fadeRestoreVolume;
    this.stopFade(false);
    if (restoreVolume !== null) {
      this.setVolume(restoreVolume);
    }
  }

  private stopFade(restoreVolume: boolean) {
    const volume = this.fadeRestoreVolume;
    this.clearFadeStartTimeout();
    this.clearFadeStepInterval();
    this.fadeState = null;
    this.fadeRestoreVolume = null;

    if (restoreVolume && volume !== null) {
      this.setVolume(volume);
    }
  }

  private syncChangeTicker() {
    this.clearChangeTicker();

    if (this.config.timer.mode !== 'time-running') {
      return;
    }

    this.changeTicker = setInterval(() => {
      this.emitChange();
    }, CHANGE_TICK_MS);
  }

  private clearExpiryTimeout() {
    if (!this.expiryTimeout) {
      return;
    }

    clearTimeout(this.expiryTimeout);
    this.expiryTimeout = null;
  }

  private clearChangeTicker() {
    if (!this.changeTicker) {
      return;
    }

    clearInterval(this.changeTicker);
    this.changeTicker = null;
  }

  private clearFadeStartTimeout() {
    if (!this.fadeStartTimeout) {
      return;
    }

    clearTimeout(this.fadeStartTimeout);
    this.fadeStartTimeout = null;
  }

  private clearFadeStepInterval() {
    if (!this.fadeStepInterval) {
      return;
    }

    clearInterval(this.fadeStepInterval);
    this.fadeStepInterval = null;
  }

  private getFadeDurationMs() {
    const normalizedSeconds = this.normalizeFadeDurationSeconds(
      this.config.fadeOut.durationSeconds,
    );

    return normalizedSeconds * 1000;
  }

  private normalizeFadeDurationSeconds(durationSeconds: number) {
    const normalized = Math.round(durationSeconds);
    if (!Number.isFinite(normalized)) {
      return 10;
    }

    return Math.min(
      MAX_FADE_OUT_DURATION_SECONDS,
      Math.max(MIN_FADE_OUT_DURATION_SECONDS, normalized),
    );
  }

  private normalizeVolume(volume: number) {
    if (!Number.isFinite(volume)) {
      return 0;
    }

    return Math.min(100, Math.max(0, Math.round(volume)));
  }

  private normalizeConfig(config: SleepTimerPluginConfig) {
    const fadeOut = {
      enabled: config.fadeOut?.enabled ?? true,
      durationSeconds: this.normalizeFadeDurationSeconds(
        config.fadeOut?.durationSeconds ?? 10,
      ),
    };

    const timer = config.timer as {
      mode: string;
      endAtMs?: number;
      remainingMs?: number;
      remainingSongs?: number;
    };

    const normalizeMode = (): SleepTimerPluginConfig['timer'] => {
      if (timer.mode === 'time-running' || timer.mode === 'running') {
        if (
          typeof timer.endAtMs === 'number' &&
          Number.isFinite(timer.endAtMs)
        ) {
          return {
            mode: 'time-running',
            endAtMs: timer.endAtMs,
          };
        }
      }

      if (timer.mode === 'time-paused' || timer.mode === 'paused') {
        if (
          typeof timer.remainingMs === 'number' &&
          Number.isFinite(timer.remainingMs)
        ) {
          return {
            mode: 'time-paused',
            remainingMs: Math.max(0, timer.remainingMs),
          };
        }
      }

      if (timer.mode === 'songs-running') {
        if (
          typeof timer.remainingSongs === 'number' &&
          Number.isFinite(timer.remainingSongs)
        ) {
          return {
            mode: 'songs-running',
            remainingSongs: Math.max(1, Math.round(timer.remainingSongs)),
          };
        }
      }

      return {
        mode: 'off',
      };
    };

    return {
      ...config,
      fadeOut,
      timer: normalizeMode(),
    };
  }

  private emitChange() {
    for (const callback of this.changeCallbacks) {
      callback();
    }
  }
}
