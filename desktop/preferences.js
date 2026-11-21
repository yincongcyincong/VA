export const screenIntervals = [
  [10, '10s'], [30, '30s'], [60, '1min'], [300, '5min'], [600, '10min'],
  [1800, '30min'], [3600, '1h'], [21600, '6h'], [86400, '24h'],
];
export const defaultScreenInterval = screenIntervals[0][0];
export const isScreenInterval = value => screenIntervals.some(([seconds]) => value === seconds);
export const screenIntervalLabel = value => screenIntervals.find(([seconds]) => value === seconds)?.[1];
export const normalizeScreenInterval = value => Number.isFinite(value)
  ? screenIntervals.reduce((nearest, [seconds]) =>
    Math.abs(seconds - value) < Math.abs(nearest - value) ? seconds : nearest, defaultScreenInterval)
  : defaultScreenInterval;

export const themes = ['default', 'sakura', 'starlight'];
