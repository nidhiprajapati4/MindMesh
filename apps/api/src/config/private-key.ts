/**
 * Turns FIREBASE_PRIVATE_KEY as it tends to be pasted into a hosting dashboard into a PEM key:
 * with or without the surrounding quotes from the JSON file, with `\n` escapes (single or doubled)
 * or real line breaks, and Windows line endings. Throws a message that never includes the key.
 */
export function normalisePrivateKey(raw: string): string {
  let key = raw.trim();
  if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key.at(-1) === key[0]) key = key.slice(1, -1);
  key = key.replace(/\\+n/g, '\n').replace(/\r\n?/g, '\n').trim();
  if (!key.startsWith('-----BEGIN PRIVATE KEY-----') || !key.endsWith('-----END PRIVATE KEY-----')) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY is not a private key. Paste the "private_key" value from the service account JSON file: ' +
        'it starts with -----BEGIN PRIVATE KEY----- and ends with -----END PRIVATE KEY-----.'
    );
  }
  return `${key}\n`;
}
