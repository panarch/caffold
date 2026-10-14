import { CellScheduler } from "./chunked-fetch/cell-scheduler.js";

// A large file a viewer shows is fetched in cells of 64 KB rather than in one
// response, so the bytes of an image or document never wait in line ahead of
// the page's other requests by more than a few cells. Every viewer in the page
// shares one schedule; the browser keeps the cells it fetched.
const scheduler = new CellScheduler({
  fetch: (url, init) => fetch(url, init),
});

// Resolves to the file as a Blob of the type the server named. Aborting the
// signal lets go of the fetch, which stops once nothing else waits for it.
export function fetchInChunks(url, { signal } = {}) {
  return scheduler.fetchFile(url, { signal });
}
