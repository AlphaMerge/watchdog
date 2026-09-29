import type { CheckContext } from '../contract.js';
import {
  ENV_MATCH,
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
 * Which instances a query keeps.
 *
 * - `wql` is a filter this code wrote, never built from a parameter.
 * - `field` and `equals` match one property to a value an operator typed. **The value never
 *   enters the script** (`S-21`): it travels in `MS_WIN_MATCH`, as the host and the account
 *   already do, and PowerShell reads it into the filter as a variable, which it never parses as
 *   code. Quoted into the text instead, it had only U+0027 doubled, and PowerShell ends a
 *   single-quoted string at U+2018 to U+201B too.
 */
export type CimFilter =
  { readonly wql: string } | { readonly field: string; readonly equals: string };

/** A CIM property name, which is all `field` may be: it is spliced, where the value is not. */
const PROPERTY = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  filter?: CimFilter,
): Promise<Record<string, unknown>[]> {
  const options = windowsOptions(context);
  const session = options.host === '' ? '' : ' -CimSession $MsSession';
  const snippet =
    `Get-CimInstance -ClassName ${cimClass}${session}${whereOf(filter)} |\n` +
    `  Select-Object -Property ${fields.join(', ')}`;
  const run = await runPowerShell(
    snippet,
    filter !== undefined && 'equals' in filter ? { ...options, match: filter.equals } : options,
  );
  return asRows(run.data);
}

/**
 * The `-Filter` argument for a query, or nothing.
 *
 * Exported for its own test, which has a real PowerShell evaluate it: the fake cannot say whether
 * the escape is one PowerShell and WQL both read the way it is meant.
 */
export function whereOf(filter: CimFilter | undefined): string {
  if (filter === undefined) return '';
  if ('wql' in filter) return ` -Filter '${filter.wql.replace(/'/g, "''")}'`;
  if (!PROPERTY.test(filter.field)) {
    throw new Error(`"${filter.field}" is not a CIM property name`);
  }
  // WQL's escape is the backslash, applied in PowerShell to a value it only ever holds.
  const value = `($env:${ENV_MATCH} -replace "(['\\\\])", '\\$1')`;
  return ` -Filter ("${filter.field} = '" + ${value} + "'")`;
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
