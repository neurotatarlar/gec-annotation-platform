/**
 * Vitest teardown hook that forces process exit after reporting active handles.
 */
export default async function teardown() {
  // Force an exit after Vitest completes to avoid lingering handles in watchless runs.
  setTimeout(() => {
    // Helpful debug when tests hang in CI/local runs: print active handles.
    // eslint-disable-next-line no-console
    console.log(
      "[vitest] active handles",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any)._getActiveHandles?.().map((h: any) => h.constructor?.name),
    );
    process.exit(0);
  }, 0);
}
