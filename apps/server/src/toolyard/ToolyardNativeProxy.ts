/** T3-CUSTOM(expbkt3): Native clients use the host's user-owned connection, never its agent key. */
export const NATIVE_MCP_REQUEST_LIMIT = 262_144;
export const NATIVE_MCP_RESPONSE_LIMIT = 8 * 1024 * 1024;
const ALLOWED_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];

export interface NativeToolyardPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}
export interface NativeToolyardConnection {
  readonly url: string;
  readonly credential: string;
}
export interface NativeToolyardProxyDependencies {
  readonly authenticate: (request: Request) => Promise<NativeToolyardPrincipal | null>;
  /** Must recheck account, instance, and connection state on every request. */
  readonly connection: (
    principal: NativeToolyardPrincipal,
  ) => Promise<NativeToolyardConnection | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const error = (status: number, code: string, message?: string) =>
  Response.json(
    { error: code, ...(message ? { message } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );

async function boundedBody(body: ReadableStream<Uint8Array> | null, maximum: number) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) throw new RangeError("body-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Preserve SSE progress and downstream backpressure; cancellation releases the upstream claim. */
function boundedResponseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  complete: () => void,
) {
  const reader = body.getReader();
  let length = 0;
  let ended = false;
  let abort = () => {};
  const finish = async () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    complete();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (ended) return;
        controller.error(
          new Error("Toolyard response stopped. Inspect execution status before another write."),
        );
        void finish();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (ended) return;
        if (chunk.done) {
          controller.close();
          await finish();
          return;
        }
        length += chunk.value.byteLength;
        if (length > NATIVE_MCP_RESPONSE_LIMIT) throw new RangeError("response-too-large");
        controller.enqueue(chunk.value);
      } catch {
        if (!ended) {
          controller.error(
            new Error("Toolyard response stopped. Inspect execution status before another write."),
          );
          await finish();
        }
      }
    },
    cancel: finish,
  });
}

/** No redirect following or automatic retry: dispatched writes can have an unknown outcome. */
export function makeNativeToolyardProxy(dependencies: NativeToolyardProxyDependencies) {
  const rates = new Map<string, { start: number; count: number; active: number }>();
  const now = dependencies.now ?? Date.now;
  let active = 0;
  return async (request: Request): Promise<Response> => {
    if (!["POST", "GET", "DELETE"].includes(request.method))
      return error(405, "method-not-allowed");
    // This endpoint accepts explicit bearer/DPoP auth only, not ambient browser cookies.
    if (!/^(Bearer|DPoP) \S+$/u.test(request.headers.get("authorization") ?? ""))
      return error(401, "t3-native-credential-required");
    const principal = await dependencies.authenticate(request).catch(() => null);
    if (!principal) return error(401, "t3-native-credential-invalid");
    const timestamp = now();
    for (const [key, entry] of rates) {
      if (!entry.active && timestamp - entry.start >= 60_000) rates.delete(key);
    }
    const rate = rates.get(principal.userId) ?? { start: timestamp, count: 0, active: 0 };
    if (timestamp - rate.start >= 60_000) {
      rate.start = timestamp;
      rate.count = 0;
    }
    if (
      rate.count >= 60 ||
      rate.active >= 4 ||
      active >= 32 ||
      (rates.size >= 1000 && !rates.has(principal.userId))
    )
      return error(429, "native-mcp-rate-limit");
    rates.set(principal.userId, rate);
    rate.count++;
    rate.active++;
    active++;
    let dispatched = false;
    let streaming = false;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const release = () => {
      if (released) return;
      released = true;
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      rate.active--;
      active--;
    };
    try {
      const declaredLength = request.headers.get("content-length");
      if (
        declaredLength &&
        (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > NATIVE_MCP_REQUEST_LIMIT)
      )
        return error(413, "native-mcp-request-too-large");
      if (
        request.method === "POST" &&
        request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
      )
        return error(415, "native-mcp-json-required");
      const body = await boundedBody(request.body, NATIVE_MCP_REQUEST_LIMIT);
      const connection = await dependencies.connection(principal);
      if (!connection) return error(403, "toolyard-connection-unavailable");
      const destination = new URL(connection.url);
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password ||
        destination.pathname !== "/mcp" ||
        destination.search ||
        destination.hash
      )
        return error(503, "toolyard-destination-invalid");
      const headers = new Headers();
      for (const name of ALLOWED_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${connection.credential}`);
      headers.set("x-t3-client-source", "native-client");
      headers.set("x-toolyard-client", "cli");
      headers.set("x-t3-session-id", `native:${principal.sessionId}`);
      dispatched = true;
      timer = setTimeout(abort, Math.max(1, Math.min(60_000, dependencies.timeoutMs ?? 60_000)));
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const response = await (dependencies.fetch ?? fetch)(destination, {
        method: request.method,
        headers,
        ...(body.byteLength ? { body } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return error(502, "toolyard-redirect-refused");
      }
      const responseHeaders = new Headers({ "cache-control": "no-store" });
      for (const name of [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "retry-after",
        "www-authenticate",
      ]) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders.set(name, value);
      }
      if (response.body === null)
        return new Response(null, { status: response.status, headers: responseHeaders });
      const output = boundedResponseStream(response.body, controller.signal, release);
      streaming = true;
      return new Response(output, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (cause) {
      if (cause instanceof RangeError && !dispatched)
        return error(413, "native-mcp-request-too-large");
      return error(
        dispatched ? 502 : 503,
        dispatched ? "toolyard-outcome-unknown" : "toolyard-connection-unavailable",
        dispatched
          ? "The upstream request did not complete. Inspect Inbox execution status before another write."
          : undefined,
      );
    } finally {
      if (!streaming) release();
    }
  };
}
