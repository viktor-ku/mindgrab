// Bump these only with a reviewed compatibility/migration plan. The worker never
// opens project storage; old tabs keep their code until every client closes.
export const STORAGE_GENERATION = 1;
export const CATALOG_VERSION = 1;
export const DOCUMENT_VERSION = 1;
export const SHELL_PROTOCOL = 1;
export const SHELL_COMPATIBILITY = {
  protocol: SHELL_PROTOCOL,
  storage: STORAGE_GENERATION,
  catalog: CATALOG_VERSION,
  document: DOCUMENT_VERSION,
};
