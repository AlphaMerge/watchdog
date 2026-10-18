import { getConfig } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ASYNC_UTIL_TIMEOUT_MS } from './setup';

describe('the test setup (U-86)', () => {
  it('gives waitFor and findBy three seconds, not the default one', () => {
    expect(ASYNC_UTIL_TIMEOUT_MS).toBe(3_000);
    expect(getConfig().asyncUtilTimeout).toBe(ASYNC_UTIL_TIMEOUT_MS);
  });
});
