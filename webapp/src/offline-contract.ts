// Fresh Loro storage. The worker never opens project storage.
export const STORAGE_GENERATION = 2;
export const CATALOG_VERSION = 1;
export const DOCUMENT_VERSION = 2;
export const SHELL_PROTOCOL = 1;
export const SHELL_COMPATIBILITY = {
  protocol: SHELL_PROTOCOL,
  storage: STORAGE_GENERATION,
  catalog: CATALOG_VERSION,
  document: DOCUMENT_VERSION,
};
