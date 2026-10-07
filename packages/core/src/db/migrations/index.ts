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
import { migration034 } from './034-readonly-accounts.js';
import { migration035 } from './035-api-tokens.js';
import { migration036 } from './036-totp.js';
import { migration037 } from './037-state-retention.js';
import { migration038 } from './038-channel-limit-source.js';
import { migration039 } from './039-probe-key-confirmed.js';
import { migration040 } from './040-runtime-channel-verdict.js';
import { migration041 } from './041-credential-delete-touch.js';
import { migration042 } from './042-runtime-resumed-at.js';
import { migration044 } from './044-maps.js';
import { migration045 } from './045-map-background.js';
import { migration046 } from './046-map-shares.js';
import { migration047 } from './047-reports.js';
import { migration048 } from './048-report-runs.js';
import { migration049 } from './049-report-outputs.js';
import { migration050 } from './050-report-xml.js';
import { migration051 } from './051-report-pdf.js';
import { migration052 } from './052-access-epoch.js';
import { migration053 } from './053-libraries.js';
import { migration054 } from './054-map-share-maker.js';
import { migration055 } from './055-rediscovery-problem.js';
import { migration056 } from './056-skipped-recipients.js';
import { migration057 } from './057-rediscovery-version.js';
import { migration058 } from './058-backfill-channels.js';
import { migration059 } from './059-sensor-voucher.js';
import { migration060 } from './060-credential-voucher.js';
import { migration061 } from './061-rediscovery-writer.js';
import { migration062 } from './062-login-address-key.js';
import { migration063 } from './063-alarm-recovering.js';
import { migration064 } from './064-flat-names-per-viewer.js';
import { migration065 } from './065-skipped-counts.js';
import { migration066 } from './066-sibling-order-only.js';
import { migration067 } from './067-late-refusal-grace.js';
import { migration068 } from './068-late-refusal-left.js';
import { migration069 } from './069-probe-protocol-flap.js';
import { migration070 } from './070-target-policy-exception.js';
import { migration072 } from './072-probe-protocol-accepted-at.js';
import { migration043 } from './043-request-settled-at.js';

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
  migration034,
  migration035,
  migration036,
  migration037,
  migration038,
  migration039,
  migration040,
  migration041,
  migration042,
  migration043,
  migration044,
  migration045,
  migration046,
  migration047,
  migration048,
  migration049,
  migration050,
  migration051,
  migration052,
  migration053,
  migration054,
  migration055,
  migration056,
  migration057,
  migration058,
  migration059,
  migration060,
  migration061,
  migration062,
  migration063,
  migration064,
  migration065,
  migration066,
  migration067,
  migration068,
  migration069,
  migration070,
  migration072,
];

export type { Migration } from './types.js';
