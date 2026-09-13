/**
 * `@ms/shared/charts` — every charting decision, for the web app and the report renderer alike
 * (`E-05`, `ADR-006` Decision 3). Browser-safe: nothing here imports outside this directory.
 */
export {
  groupByUnit,
  groupExtent,
  hasReadings,
  type ChartChannel,
  type ChartGroup,
} from './groups.js';
export {
  LIGHT_CHART_THEME,
  SERIES_SLOTS,
  seriesColour,
  seriesWash,
  type ChartTheme,
} from './palette.js';
export { baselineExtent, formatTick, niceScale, type NiceScale } from './scale.js';
export {
  layoutChart,
  type ChartInput,
  type ChartLayout,
  type ChartSeriesLayout,
  type Point,
  type TimeTick,
} from './layout.js';
