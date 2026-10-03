import { QueryClient } from "@tanstack/solid-query";
import type { MutationOptions, QueryKey } from "@tanstack/solid-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Local storage and shell inspection must work without a network.
        networkMode: "always",
        retry: false,
        refetchOnWindowFocus: false,
        gcTime: 60_000,
      },
      mutations: {
        networkMode: "always",
        // Retrying writes is an explicit user or CRDT protocol decision.
        retry: false,
        gcTime: 0,
      },
    },
  });
}

export const queryClient = createQueryClient();

// Services outside Solid's component tree use the same mutation cache.
export function executeMutation<TData, TVariables>(
  client: QueryClient,
  options: MutationOptions<TData, Error, TVariables>,
  variables: TVariables,
) {
  return client.getMutationCache().build(client, options).execute(variables);
}

export function catalogKey(catalog: string) {
  return ["local-projects", catalog] as const;
}

// A canceled account/project lifetime cannot share a request with its successor.
export async function fetchScopedQuery<T>(
  client: QueryClient,
  queryKey: QueryKey,
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  const cancel = () => void client.cancelQueries({ queryKey, exact: true });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await client.fetchQuery({
      queryKey,
      queryFn: ({ signal: querySignal }) =>
        read(AbortSignal.any([signal, querySignal])),
      staleTime: 0,
      gcTime: 0,
      structuralSharing: false,
    });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
