export const lookupSummarySchema = {
  $id: 'ms:lookupSummary',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'type', 'undefinedState', 'entryCount', 'source'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    type: { enum: ['singleInt', 'range'] },
    undefinedState: { enum: ['up', 'warning', 'down'] },
    entryCount: { type: 'integer' },
    /** True when an operator's file replaced a definition this build ships. */
    overridesBuiltIn: { type: 'boolean' },
    // Open on purpose (`P-361`): a path is whatever the operator's directory holds.
    source: {
      type: 'string',
      description: '`built-in`, or the path of the file the definition was read from.',
    },
  },
} as const;

/**
 * A definition that could not be used.
 *
 * Served beside the ones that loaded, on purpose. A refused lookup leaves its channels judged
 * by nothing, and a sensor reading Up for that reason is the failure this whole endpoint exists
 * to make visible — an operator should not have to read the journal to find it.
 */
export const lookupProblemSchema = {
  $id: 'ms:lookupProblem',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'source', 'problems'],
  properties: {
    id: { type: 'string' },
    source: {
      type: 'string',
      description: '`built-in`, or the path of the file that was refused.',
    },
    problems: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const lookupDetailSchema = {
  $id: 'ms:lookupDetail',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'description', 'type', 'undefinedState', 'entries'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    type: { enum: ['singleInt', 'range'] },
    undefinedState: { enum: ['up', 'warning', 'down'] },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'text'],
        properties: {
          value: { type: 'number' },
          from: { type: 'number' },
          to: { type: 'number' },
          state: { enum: ['up', 'warning', 'down'] },
          text: { type: 'string' },
        },
      },
    },
  },
} as const;

export const LOOKUP_SCHEMAS = [lookupSummarySchema, lookupProblemSchema, lookupDetailSchema];
