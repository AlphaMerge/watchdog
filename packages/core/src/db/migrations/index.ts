import type { Migration } from './types.js';
import { migration001 } from './001-object-model.js';
import { migration002 } from './002-tree-api.js';
import { migration003 } from './003-timeseries.js';
import { migration004 } from './004-rollups.js';
import { migration005 } from './005-audit-log.js';
import { migration006 } from './006-sibling-order.js';
import { migration007 } from './007-probe-identity.js';
import { migration008 } from './008-sensor-runtime.js';
import { migration009 } from './009-channel-lookup.js';

/**
 * Every migration this build knows about, in order.
 *
 * Append only. Never renumber, never edit a migration that has shipped — the migrator compares
 * checksums and refuses to run if an applied migration's text has changed.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
];

export type { Migration } from './types.js';
