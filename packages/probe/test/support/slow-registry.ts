import registry from './check-fixtures.js';

/**
 * The fixture registry, taking 400 ms to import (`P-206`).
 *
 * A real worker spends its first few hundred milliseconds importing the catalogue, and that window
 * is where the pool's spawn limit applies. The fixtures import instantly, which would let every
 * spawn finish before a test could see how many were loading at once.
 */
await new Promise((resolve) => setTimeout(resolve, 400));

export default registry;
