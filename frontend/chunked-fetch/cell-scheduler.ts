import { InFlightLimit } from "./in-flight-limit.ts";
import {
  abortError,
  type Cell,
  type CellAnswer,
  type FetchedFile,
  Transfer,
} from "./transfer.ts";

type FetchCell = (url: string, init: RequestInit) => Promise<Response>;

// Decides which cell is asked for next, across every file being fetched, and
// keeps no more cells in flight than the limit allows. The file asked for
// most recently goes first, so what was just opened appears first; an earlier
// file waits, without being dropped, until that one is done.
export class CellScheduler {
  private readonly fetchCell: FetchCell;
  private readonly now: () => number;
  private readonly limit = new InFlightLimit();
  // Most recently asked for last.
  private readonly transfers: Transfer[] = [];
  private inFlight = 0;

  constructor({
    fetch,
    now = () => performance.now(),
  }: {
    fetch: FetchCell;
    now?: () => number;
  }) {
    this.fetchCell = fetch;
    this.now = now;
  }

  // The same address asked for again while it is still arriving shares that
  // fetch, which stops only when every caller has let go.
  fetchFile(
    url: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<FetchedFile> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    let transfer = this.transfers.find(
      (candidate) => candidate.url === url && !candidate.ended,
    );
    if (transfer) {
      this.transfers.splice(this.transfers.indexOf(transfer), 1);
    } else {
      const created = new Transfer(url);
      const forget = () => this.forget(created);
      created.done.then(forget, forget);
      transfer = created;
    }
    this.transfers.push(transfer);
    transfer.callers += 1;
    const answer = callerAnswer(transfer, signal);
    this.pump();
    return answer;
  }

  private pump() {
    while (this.inFlight < this.limit.allowedCells()) {
      const cell = this.nextCell();
      if (!cell) {
        return;
      }
      this.inFlight += 1;
      void this.request(cell);
    }
  }

  private nextCell() {
    for (let index = this.transfers.length - 1; index >= 0; index -= 1) {
      const cell = this.transfers[index].takeCell(this.limit.round);
      if (cell) {
        return cell;
      }
    }
    return null;
  }

  // A cell is in flight until all its bytes have arrived; its first byte, the
  // answer's headers, tells the limit how long it waited.
  private async request(cell: Cell) {
    const sent = this.now();
    let answer: CellAnswer;
    try {
      const response = await this.fetchCell(cell.url, {
        headers: { Range: cell.range },
        priority: "low",
        signal: cell.controller.signal,
      });
      const waitMs = this.now() - sent;
      this.limit.observe({
        round: cell.round,
        waitMs,
        fromCache: cell.transfer.recordWait(cell, waitMs),
      });
      answer = await readAnswer(response);
    } catch (error) {
      answer = { kind: "failed", error };
    }
    this.inFlight -= 1;
    cell.transfer.answer(cell, answer);
    this.pump();
  }

  private forget(transfer: Transfer) {
    const index = this.transfers.indexOf(transfer);
    if (index >= 0) {
      this.transfers.splice(index, 1);
    }
    if (this.transfers.length === 0) {
      this.limit.reset();
    }
    this.pump();
  }
}

function callerAnswer(transfer: Transfer, signal: AbortSignal | undefined) {
  return new Promise<FetchedFile>((resolve, reject) => {
    let settled = false;
    const settle = <T>(finish: (value: T) => void, value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", letGo);
      finish(value);
    };
    const letGo = () => {
      if (settled) {
        return;
      }
      settle(reject, abortError());
      transfer.callers -= 1;
      if (transfer.callers === 0) {
        transfer.cancel();
      }
    };
    signal?.addEventListener("abort", letGo, { once: true });
    transfer.done.then(
      (fetched) => settle(resolve, fetched),
      (error) => settle(reject, error),
    );
  });
}

async function readAnswer(response: Response): Promise<CellAnswer> {
  const type = response.headers.get("Content-Type") ?? "";
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    if (!range) {
      return { kind: "failed", status: 206 };
    }
    return {
      kind: "part",
      first: Number(range[1]),
      size: Number(range[3]),
      version: versionOf(response.headers.get("ETag")),
      type,
      bytes: await response.arrayBuffer(),
    };
  }
  if (response.status === 200) {
    return {
      kind: "whole",
      version: versionOf(response.headers.get("ETag")),
      type,
      bytes: await response.arrayBuffer(),
    };
  }
  if (response.status === 416) {
    const size = /^bytes \*\/(\d+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    return {
      kind: "out-of-range",
      size: size ? Number(size[1]) : null,
      version: versionOf(response.headers.get("ETag")),
      type,
    };
  }
  if (response.status === 412) {
    return { kind: "changed" };
  }
  return { kind: "failed", status: response.status };
}

function versionOf(etag: string | null) {
  return /^(?:W\/)?"([^"]*)"$/.exec(etag ?? "")?.[1] ?? "";
}
