/**
 * Minimal electron stub for headless unit tests.
 *
 * The real `electron` package exports a path string from its CJS entry, so
 * `import { App } from "electron"` would silently yield `undefined` at
 * runtime. Tests only need the *type* shape — this stub keeps module loading
 * deterministic.
 */

export class App {}

export default {};
