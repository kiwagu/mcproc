/** POSIX single-quote quoting: safe for any byte sequence, including newlines. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shjoin(argv: string[]): string {
  return argv.map(shq).join(' ');
}
