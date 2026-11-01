/**
 * The text of Ember's OS notifications: a body the notification centre shows whole is kept short, cut at a word with an
 * ellipsis (a cut mid-word read as a typo, and nothing said it went on). Pure; main shows the notification.
 */

/** The longest body Ember sends to a notification. */
export const NOTIFICATION_MAX = 240;

/** `body` as a notification shows it: whole when it fits, else cut at the last word that fits, ending in "…". */
export function notificationBody(body: string, max = NOTIFICATION_MAX): string {
  if (body.length <= max) return body;
  const room = body.slice(0, max - 1);
  const space = room.search(/\s\S*$/);
  // One very long word (a path, a link): cut it where the room ends.
  const cut = space > max / 2 ? room.slice(0, space) : room;
  return `${cut.trimEnd()}…`;
}
