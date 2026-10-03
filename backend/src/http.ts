import type { Config } from "./config";
import { loopback, origin } from "./config";
import { ApiError } from "./errors";

export function sameOrigin(request: Request, config: Config) {
  if (request.headers.get("origin") !== origin(config))
    throw new ApiError("invalid_origin");
}

export function responseHeaders(
  response: Response,
  request: Request,
  config: Config,
  started: number,
) {
  const headers = response.headers;
  if (new URL(request.url).pathname !== "/") {
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.append(
      "Server-Timing",
      `request;dur=${(performance.now() - started).toFixed(3)}`,
    );
  }
  const local = loopback(new URL(config.appUrl).hostname);
  if (local) headers.set("Access-Control-Allow-Origin", "*");
  else {
    headers.set("Vary", "Origin");
    if (request.headers.get("origin") === origin(config))
      headers.set("Access-Control-Allow-Origin", origin(config));
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  headers.set("Access-Control-Expose-Headers", "server-timing,retry-after");
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET,POST");
    headers.set(
      "Access-Control-Allow-Headers",
      "content-type,authorization,x-mindgrab-schema-version,x-mindgrab-account",
    );
  }
  return response;
}

export async function readBody(request: Request, maximum: number) {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))
  )
    throw new ApiError("resource_limit");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 15000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (expired) throw new ApiError("resource_limit");
      if (done) break;
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new ApiError("resource_limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch {
    throw new ApiError("resource_limit");
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function parameters(url: URL) {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) throw new ApiError("invalid_request");
    result[key] = value;
  }
  return result;
}
