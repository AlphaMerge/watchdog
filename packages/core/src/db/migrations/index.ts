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
import { migration020 } from './020-notification-summaries.js';
import { migration021 } from './021-template-schedules.js';
import { migration022 } from './022-trigger-inheritance.js';
import { migration023 } from './023-channel-counters.js';
import { migration024 } from './024-mail-credential.js';
import { migration025 } from './025-discovery-runs.js';
import { migration026 } from './026-discovery-identify.js';
import { migration027 } from './027-discovery-provisioning.js';
import { migration028 } from './028-discovery-levels.js';
import { migration029 } from './029-rediscovery.js';
import { migration030 } from './030-probe-registration.js';
import { migration031 } from './031-accounts.js';
import { migration032 } from './032-user-groups.js';
import { migration033 } from './033-object-access.js';

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
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
  migration031,
  migration032,
  migration033,
];

export type { Migration } from './types.js';
