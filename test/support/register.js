import { register } from 'node:module';

/**
 * Loaded via `--import` so the hooks are in place before the first test file is resolved.
 * Registering from inside a test would be too late: its own imports are hoisted and
 * resolved before any of its code runs.
 */
register('./vite-imports.js', import.meta.url);
