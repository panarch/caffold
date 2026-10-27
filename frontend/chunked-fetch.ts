import { CellScheduler } from "./chunked-fetch/cell-scheduler.js";
import type { FetchedFile } from "./chunked-fetch/transfer.js";

export type { FetchedFile } from "./chunked-fetch/transfer.js";

// A large file a viewer shows is fetched in cells of 64 KB rather than in one
// response, so the bytes of an image or document never wait in line ahead of
// the page's other requests by more than a few cells. Every viewer in the page
// shares one schedule; the browser keeps the cells it fetched.
const scheduler = new CellScheduler({
  fetch: (url, init) => fetch(url, init),
});

// Resolves to the file, a Blob of the type the server named, and the version
// the server named it by (its ETag), or null when it named none. Aborting the
// signal lets go of the fetch, which stops once nothing else waits for it.
export function fetchInChunks(
  url: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<FetchedFile> {
  return scheduler.fetchFile(url, { signal });
}
