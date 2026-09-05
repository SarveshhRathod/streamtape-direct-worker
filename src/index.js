const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function corsHeaders(origin) {
  const allowOrigin = origin || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, Range, If-None-Match, If-Modified-Since, Origin, Accept, Referer, User-Agent",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag, Last-Modified, Location, X-Request-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(payload, init = {}, origin = null) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  const cors = corsHeaders(origin);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers,
  });
}

function buildRequestId(request) {
  return request.headers.get("cf-ray") || crypto.randomUUID();
}

function getOrigin(request) {
  return request.headers.get("Origin");
}

function getMode(url) {
  const mode = (url.searchParams.get("mode") || "redirect").toLowerCase();
  return mode === "json" ? "json" : "redirect";
}

function parseAllowlist(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedUrl(targetUrl, allowlist) {
  if (!allowlist.length) return true;
  try {
    const url = new URL(targetUrl);
    return allowlist.some((allowed) => {
      try {
        return url.origin === new URL(allowed).origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function pickForwardHeaders(request) {
  const headers = new Headers();

  const ua = request.headers.get("User-Agent") || DEFAULT_USER_AGENT;
  const accept = request.headers.get("Accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const referer = request.headers.get("Referer");
  const origin = request.headers.get("Origin");
  const range = request.headers.get("Range");
  const ifNoneMatch = request.headers.get("If-None-Match");
  const ifModifiedSince = request.headers.get("If-Modified-Since");

  headers.set("User-Agent", ua);
  headers.set("Accept", accept);
  if (referer) headers.set("Referer", referer);
  if (origin) headers.set("Origin", origin);
  if (range) headers.set("Range", range);
  if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
  if (ifModifiedSince) headers.set("If-Modified-Since", ifModifiedSince);

  return headers;
}

function passthroughResponseHeaders(upstream, origin) {
  const headers = new Headers(corsHeaders(origin));
  const allow = [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Cache-Control",
    "Expires",
    "Location",
  ];

  for (const key of allow) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }

  return headers;
}

function safeError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ? String(err.stack).split("\n").slice(0, 4) : undefined,
    };
  }
  return { message: String(err) };
}

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const origin = getOrigin(request);
    const requestId = buildRequestId(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          "X-Request-Id": requestId,
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        {
          ok: false,
          error: "method_not_allowed",
          message: "Use GET, HEAD, or OPTIONS.",
          requestId,
        },
        { status: 405, headers: { Allow: "GET,HEAD,OPTIONS", "X-Request-Id": requestId } },
        origin
      );
    }

    const targetUrl = requestUrl.searchParams.get("url");
    const mode = getMode(requestUrl);
    const allowlist = parseAllowlist(env.ALLOWED_ORIGINS);

    if (!targetUrl) {
      return jsonResponse(
        {
          ok: false,
          error: "missing_url",
          message: "Provide ?url=https://...",
          requestId,
          usage: `${requestUrl.origin}/?mode=json&url=https://example.com/video.mp4`,
        },
        { status: 400, headers: { "X-Request-Id": requestId } },
        origin
      );
    }

    if (!isAllowedUrl(targetUrl, allowlist)) {
      return jsonResponse(
        {
          ok: false,
          error: "origin_not_allowed",
          message: "Target origin is not allowed by ALLOWED_ORIGINS.",
          requestId,
        },
        { status: 403, headers: { "X-Request-Id": requestId } },
        origin
      );
    }

    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: pickForwardHeaders(request),
        redirect: "manual",
      });

      const location = upstream.headers.get("Location");

      if (mode === "json") {
        return jsonResponse(
          {
            ok: true,
            requestId,
            upstream: {
              status: upstream.status,
              ok: upstream.ok,
              redirected: upstream.redirected,
              url: upstream.url,
              location,
              headers: {
                contentType: upstream.headers.get("Content-Type"),
                contentLength: upstream.headers.get("Content-Length"),
                contentRange: upstream.headers.get("Content-Range"),
                acceptRanges: upstream.headers.get("Accept-Ranges"),
                etag: upstream.headers.get("ETag"),
                lastModified: upstream.headers.get("Last-Modified"),
                cacheControl: upstream.headers.get("Cache-Control"),
              },
            },
          },
          { status: 200, headers: { "X-Request-Id": requestId } },
          origin
        );
      }

      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const headers = new Headers(corsHeaders(origin));
        headers.set("X-Request-Id", requestId);
        if (location) headers.set("Location", location);
        return new Response(null, {
          status: 302,
          headers,
        });
      }

      const headers = passthroughResponseHeaders(upstream, origin);
      headers.set("X-Request-Id", requestId);

      return new Response(request.method === "HEAD" ? null : upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: "upstream_failure",
          message: "Upstream request failed.",
          requestId,
          ...(env.DEBUG === "true" ? { trace: safeError(err) } : {}),
        },
        { status: 502, headers: { "X-Request-Id": requestId } },
        origin
      );
    }
  },
};
