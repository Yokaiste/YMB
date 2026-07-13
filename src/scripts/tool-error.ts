import type { BuildScriptAssertionOptions } from '../types.ts';

export class ScriptToolError extends Error {
  readonly options: BuildScriptAssertionOptions;

  constructor(options: BuildScriptAssertionOptions) {
    super(options.reason);
    this.name = 'ScriptToolError';
    this.options = options;
  }
}
