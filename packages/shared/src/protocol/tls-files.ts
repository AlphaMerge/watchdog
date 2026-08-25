import { readFileSync } from 'node:fs';
import { AppError } from '../errors/app-error.js';
import type { TlsConfig } from '../config/schema.js';

export interface LoadedTlsMaterial {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

/**
 * Reads the mutual-TLS material, naming the setting and the failure when it cannot.
 *
 * `EACCES: permission denied, open '/etc/ms/tls/core.crt'` tells an operator almost nothing —
 * which setting, which service, what to fix. CLAUDE.md: errors carry context.
 */
export function loadTlsMaterial(config: TlsConfig, settingPath: string): LoadedTlsMaterial {
  const read = (file: string, setting: string): Buffer => {
    if (file === '') {
      throw new AppError('TLS_NOT_CONFIGURED', `${settingPath}.${setting} is not set`, {
        context: { setting: `${settingPath}.${setting}` },
      });
    }
    try {
      return readFileSync(file);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? 'unknown';
      const hint =
        code === 'EACCES'
          ? 'the service user cannot read it — check ownership and that every directory on the path is traversable'
          : code === 'ENOENT'
            ? 'the file does not exist'
            : 'the file could not be read';
      throw new AppError(
        'TLS_FILE_UNREADABLE',
        `cannot read ${settingPath}.${setting} (${file}): ${hint}`,
        { context: { setting: `${settingPath}.${setting}`, file, code }, cause },
      );
    }
  };

  return {
    cert: read(config.certFile, 'certFile'),
    key: read(config.keyFile, 'keyFile'),
    ca: read(config.caFile, 'caFile'),
  };
}
