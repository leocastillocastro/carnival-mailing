/** True once a job has used up every attempt BullMQ was configured to give it —
 * that's the point where the failure is permanent and should be persisted, rather
 * than left for BullMQ's own backoff/retry to try again. */
export function isFinalAttempt(attemptsMade: number, maxAttempts: number): boolean {
  return attemptsMade >= maxAttempts;
}
