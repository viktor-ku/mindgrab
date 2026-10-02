type Payload = { query: string; variables?: Record<string, unknown>; operationName?: string };

export function parsePayload(text: string): Payload {
  let value: any;
  try { value = JSON.parse(text); }
  catch { throw new Error("Request must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.query !== "string" || !value.query.trim()) {
    throw new Error("Request must contain a nonempty GraphQL query string.");
  }
  if (value.variables !== undefined && (!value.variables || typeof value.variables !== "object" || Array.isArray(value.variables))) {
    throw new Error("Request variables must be an object.");
  }
  if (value.operationName !== undefined && typeof value.operationName !== "string") {
    throw new Error("Request operationName must be a string.");
  }
  return { query: value.query, variables: value.variables, operationName: value.operationName };
}

export async function requestLinear(payload: Payload, key: string, send: typeof fetch = fetch) {
  if (!key.trim()) throw new Error("Missing LINEAR_API_KEY. Set it in .env and run with bun --bun --env-file=.env.");
  let response: Response;
  try {
    response = await send("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key.trim() },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      verbose: false,
    });
  } catch {
    throw new Error("Linear request failed or timed out. A mutation may have completed; check its state before retrying.");
  }
  let body: any;
  try { body = await response.json(); }
  catch { throw new Error(`Linear returned HTTP ${response.status} with a non-JSON response. Check state before retrying a mutation.`); }
  const valid = body && typeof body === "object" && !Array.isArray(body) &&
    (Object.hasOwn(body, "data") || Array.isArray(body.errors));
  const failed = !response.ok || !valid || (Array.isArray(body.errors) && body.errors.length > 0);
  const output = failed
    ? { httpStatus: response.status, retryAfter: response.headers.get("retry-after"), response: body }
    : body;
  return { failed, output: JSON.stringify(output, null, 2).replaceAll(key.trim(), "[REDACTED]") };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log("Usage: bun --bun --env-file=.env linear.ts <request.json|->\nJSON fields: query, variables?, operationName?. Reads LINEAR_API_KEY from the environment.");
    } else {
      if (args.length !== 1) throw new Error("Expected a JSON request file or - for stdin. Use --help for usage.");
      let input: string;
      try { input = await (args[0] === "-" ? Bun.stdin : Bun.file(args[0])).text(); }
      catch { throw new Error("Could not read the request file or stdin."); }
      const result = await requestLinear(parsePayload(input), Bun.env.LINEAR_API_KEY ?? "");
      console.log(result.output);
      if (result.failed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Linear request failed.");
    process.exitCode = 1;
  }
}
