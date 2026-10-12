/** At most this many new bytes are read per file per read; a bigger burst is read from its newest part. */
export const READ_CAP = 1048576;
/** History (the first read, or a replaced file) comes from this many last bytes: the last lines are picked from them. */
export const HISTORY_BYTES = 262144;
export const HEX = /^[0-9a-f]{1,64}$/;

/**
 * One file's read: the position it continues from (null: none yet), the size measured, where the read began and why
 * (H history, R the file was replaced or shrank, S a burst over READ_CAP, N new bytes), the hex of the 16 bytes before
 * `size`, and the bytes read, counted exactly.
 */
export interface LogChunk {
  from: number | null;
  size: number;
  start: number;
  kind: 'H' | 'R' | 'S' | 'N';
  anchor: string;
  body: string;
  got: number;
}
/** Where a file is followed from: the offset reached and the anchor known for it (null before the first read). */
export interface ChunkRequest {
  path: string;
  off: number | null;
  anchor: string | null;
}
