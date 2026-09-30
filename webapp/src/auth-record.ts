import { StorageError } from "./project-repository";

// The account hint is not authorization. IndexedDB's committed transaction is
// needed because localStorage may still be buffered when the browser crashes.
export interface AuthRecord {
  revision: string;
  sequence?: number;
}
const STORE = "records";

async function database(key: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(`${key}/durable`, 1);
    } catch (error) {
      reject(new StorageError("unavailable", error));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new StorageError("blocked"));
    }, 2000);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => {
      clearTimeout(timer);
      reject(new StorageError("open", request.error));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (timedOut) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
export async function readAuthRecord(key: string): Promise<unknown> {
  const db = await database(key);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function writeAuthRecord<T extends AuthRecord>(
  key: string,
  record: T,
  current: () => boolean,
): Promise<T | undefined> {
  const db = await database(key);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
      const store = tx.objectStore(STORE);
      const previous = store.get(key);
      let saved: T | undefined;
      previous.onsuccess = () => {
        // Another tab's logout/account transition supersedes a delayed writer.
        if (!current()) return;
        const sequence = (previous.result?.sequence ?? 0) + 1;
        if (!Number.isSafeInteger(sequence)) {
          tx.abort();
          return;
        }
        saved = { ...record, sequence };
        store.put(saved, key);
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Account storage did not commit."));
    });
  } finally {
    db.close();
  }
}
