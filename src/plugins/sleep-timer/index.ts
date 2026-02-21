import { createPlugin } from '@/utils';
import { t } from '@/i18n';

import { backend } from './main';
import { onMenu } from './menu';

import type { SleepTimerPluginConfig } from './types';

export const defaultConfig: SleepTimerPluginConfig = {
  enabled: false,
  expiryAction: 'pause',
  pauseWhenPlaybackPaused: false,
  fadeOut: {
    enabled: true,
    durationSeconds: 10,
  },
  timer: {
    mode: 'off',
  },
  lastSetMinutes: 30,
  lastSetSongs: 3,
};

export default createPlugin({
  name: () => t('plugins.sleep-timer.name'),
  description: () => t('plugins.sleep-timer.description'),
  config: defaultConfig,
  menu: onMenu,
  backend,
});
