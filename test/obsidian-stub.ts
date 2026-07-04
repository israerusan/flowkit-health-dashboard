// Minimal stand-in for the `obsidian` module so the pure scoring logic can be
// bundled and executed under Node in tests. Only the runtime values that
// scoring.ts imports are needed; everything else in `obsidian` is types (erased)
// or unused by the code under test.
export const apiVersion = "1.5.0";
