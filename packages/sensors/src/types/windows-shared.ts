import type { CheckContext } from '../contract.js';
import {
  asRows,
  numberFrom,
  runPowerShell,
  WINDOWS_SCHEMA,
  windowsOptions,
} from '../support/windows/index.js';

/**
 * What the four Windows sensors share (`T-10`).
 *
 * One query helper and one parameter block, so a new Windows type cannot invent a second
 * spelling of "which machine" or forget that a blank host means this one.
 */

export { WINDOWS_SCHEMA };

/**
 * Runs one CIM query and returns its rows.
 *
 * **Always through `asRows`.** `ConvertTo-Json` turns one object into an object and two into an
 * array, and a machine with one disk is not a rare machine.
 *
 * **`Select-Object` is not optional.** A bare `Get-CimInstance` serialises every property the
 * class has plus the CIM plumbing — `Win32_LogicalDisk` alone is forty fields — which is a
 * hundred kilobytes down the pipe once a minute for four numbers. Naming the fields also means a
 * property that disappears in a future Windows arrives as a missing field rather than as a
 * document that grew.
 */
export async function queryCim(
  context: CheckContext,
  cimClass: string,
  fields: readonly string[],
  filter = '',
): Promise<Record<string, unknown>[]> {
  const options = windowsOptions(context);
  const where = filter === '' ? '' : ` -Filter '${filter.replace(/'/g, "''")}'`;
  const session = options.host === '' ? '' : ' -CimSession $MsSession';
  const snippet =
    `Get-CimInstance -ClassName ${cimClass}${session}${where} |\n` +
    `  Select-Object -Property ${fields.join(', ')}`;
  const run = await runPowerShell(snippet, options);
  return asRows(run.data);
}

/** A field as a number, or null for a gap. Never a zero standing in for absence. */
export function fieldNumber(row: Record<string, unknown>, key: string): number | null {
  return numberFrom(row[key]);
}

/** A field as text, for a message or a comparison. */
export function fieldText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Bytes from a WMI field counted in kibibytes, which is how `Win32_OperatingSystem` reports. */
export function bytesFromKib(row: Record<string, unknown>, key: string): number | null {
  const value = numberFrom(row[key]);
  return value === null ? null : value * 1024;
}

/** A percentage, gapped rather than zeroed when the total is missing or zero. */
export function percentOf(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total === 0) return null;
  return Math.round((part / total) * 1e4) / 1e2;
}

/** `C:` from `c`, `C:\` or `C:` — an operator types all three. */
export function driveKey(deviceId: string): string {
  return deviceId.replace(/[^A-Za-z]/g, '').toLowerCase();
}
