/**
 * The part of `T-19` the *probe* needs, without the part that runs a program.
 *
 * `main.ts` has to name the environment variable it puts the script directory in, and importing
 * the resolver for a constant would drag `node:fs` and the whole running path into the probe's
 * own thread. One name, exported on its own.
 */
export { SCRIPT_DIR_ENV } from './resolve.js';
export { SCRIPT_GRACE_MS } from './grace.js';
