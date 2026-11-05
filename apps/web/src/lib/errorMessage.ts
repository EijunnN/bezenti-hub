/** An error's own message for the user, or the fallback when it carries none. */
export const errorMessageOf = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
