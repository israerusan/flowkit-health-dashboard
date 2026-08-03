// Minimal stand-in for the `obsidian` module so the pure scoring logic can be
// bundled and executed under Node in tests. Only the runtime values that
// scoring.ts imports are needed; everything else in `obsidian` is types (erased)
// or unused by the code under test.
export const apiVersion = "1.5.0";

/**
 * The tests never exercise a real lookup — `selectForLookup` and the verdict
 * logic are the parts worth testing, and both are pure. This exists only so the
 * module that imports it can be bundled; calling it is a test bug, so it says so
 * rather than quietly returning something plausible.
 */
export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests");
}
