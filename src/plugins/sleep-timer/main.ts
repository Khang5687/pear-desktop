import { powerMonitor } from 'electron';

import { registerCallback, SongInfoEvent } from '@/providers/song-info';
import { getSongControls } from '@/providers/song-controls';
import { createBackend } from '@/utils';

import { SleepTimerService } from './service';

import type { SleepTimerPluginConfig } from './types';
import type { VolumeState } from '@/types/datahost-get-state';

export let sleepTimerService: SleepTimerService | null = null;

export const backend = createBackend<
  {
    active: boolean;
    currentVolume: number;
    onSuspend?: () => void;
    onResume?: () => void;
  },
  SleepTimerPluginConfig
>({
  active: false,
  currentVolume: 100,

  async start(ctx) {
    this.active = true;
    this.currentVolume = 100;

    const initialConfig = await ctx.getConfig();
    const controls = getSongControls(ctx.window);
    const service = new SleepTimerService({
      initialConfig,
      setConfig: ctx.setConfig,
      pausePlayback: () => controls.pause(),
      setVolume: (volume) => controls.setVolume(volume),
      getCurrentVolume: () => this.currentVolume,
    });

    sleepTimerService = service;

    registerCallback((songInfo, event) => {
      if (!this.active || sleepTimerService !== service) {
        return;
      }

      service
        .onSongEvent(
          songInfo.videoId,
          event === SongInfoEvent.VideoSrcChanged,
          songInfo.elapsedSeconds,
          songInfo.songDuration,
          songInfo.isPaused,
        )
        .catch((error) => {
          console.error(error);
        });

      if (event === SongInfoEvent.PlayOrPaused) {
        if (typeof songInfo.isPaused !== 'boolean') {
          return;
        }

        service.setPlaybackPaused(songInfo.isPaused).catch((error) => {
          console.error(error);
        });
      }
    });

    ctx.ipc.on('peard:player-api-loaded', () => {
      if (!this.active || sleepTimerService !== service) {
        return;
      }

      ctx.ipc.send('peard:setup-volume-changed-listener');
      ctx.ipc.send('peard:setup-time-changed-listener');
      ctx.ipc.send('peard:setup-seeked-listener');
      service.onPlayerApiReady();
    });

    ctx.ipc.on('peard:volume-changed', (newVolumeState: VolumeState) => {
      if (!this.active || sleepTimerService !== service) {
        return;
      }

      this.currentVolume = newVolumeState.isMuted ? 0 : newVolumeState.state;
    });

    this.onSuspend = () => {
      if (!this.active || sleepTimerService !== service) {
        return;
      }

      service.onSuspend();
    };

    this.onResume = () => {
      if (!this.active || sleepTimerService !== service) {
        return;
      }

      service.onResume().catch((error) => {
        console.error(error);
      });
    };

    powerMonitor.on('suspend', this.onSuspend);
    powerMonitor.on('resume', this.onResume);

    await service.applyConfig(initialConfig);
  },

  stop() {
    this.active = false;

    if (this.onSuspend) {
      powerMonitor.off('suspend', this.onSuspend);
      this.onSuspend = undefined;
    }

    if (this.onResume) {
      powerMonitor.off('resume', this.onResume);
      this.onResume = undefined;
    }

    sleepTimerService?.destroy();
    sleepTimerService = null;
  },

  async onConfigChange(newConfig) {
    await sleepTimerService?.applyConfig(newConfig);
  },
});
