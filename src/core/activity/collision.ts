/** A file is announced at most once in this many milliseconds. */
export const COLLISION_QUIET_MS = 30_000;

/**
 * Should a "changed on disk while you have unsaved edits" warning be shown now.
 * `lastAt` is when this file was last announced (undefined = never).
 */
export function shouldNotify(lastAt: number | undefined, now: number, enabled: boolean): boolean {
  if (!enabled) return false;
  if (lastAt === undefined) return true;
  // a clock that moved backwards must not silence the file forever
  return now - lastAt >= COLLISION_QUIET_MS || now < lastAt;
}

export function collisionMessage(name: string): string {
  return `${name} was changed on disk while you have unsaved edits.`;
}

export const COLLISION_ACTIONS = { COMPARE: 'Compare with Saved', DISMISS: 'Dismiss' } as const;
