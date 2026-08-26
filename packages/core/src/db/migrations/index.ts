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
import { migration010 } from './010-object-pause.js';
import { migration011 } from './011-schedules.js';
import { migration012 } from './012-maintenance-window.js';
import { migration013 } from './013-dependencies.js';
import { migration014 } from './014-acknowledgement.js';
import { migration015 } from './015-notification-triggers.js';
import { migration016 } from './016-notification-alarms.js';
import { migration017 } from './017-threshold-alarms.js';
import { migration018 } from './018-notification-templates.js';
import { migration019 } from './019-notification-delivery.js';

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
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
];

export type { Migration } from './types.js';
