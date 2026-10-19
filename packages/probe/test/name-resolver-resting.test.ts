/**
 * N7 (`P-432` S3, §7.3): `P-426`'s and `P-438`'s cases, `name-resolver.test.ts`, run again in gate
 * mode with the lookup helper resting. Resting, the probe asks every name on its own lanes as
 * `system` does (§1.3), D24's first-lane rule being `P-438`'s, so every case gives `system`'s
 * result. The cases are that file's own, registered by importing it once the gate is asked for.
 */
process.env['MS_RESOLVER_GATE'] = 'resting';
await import('./name-resolver.test.js');

export {};
