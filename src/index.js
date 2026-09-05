export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "No URL provided.",
          usage: `${requestUrl.origin}/?url=https://streamtape.com/v/VIDEO_ID/...`
        }, null, 2),
        {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        }
      );
    }

    try {
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      // 1. Client ka original IP extract karein
      const clientIp = request.headers.get("CF-Connecting-IP") || 
                       request.headers.get("X-Real-IP") || 
                       "127.0.0.1";

      // 2. IP forwarding headers inject karein
      const upstreamHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
        "X-Forwarded-For": clientIp,
        "CF-Connecting-IP": clientIp,
        "X-Real-IP": clientIp,
        "Client-IP": clientIp,
      };

      // 3. Fetch embed page
      const embedRes = await fetch(embedUrl, { headers: upstreamHeaders });
      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json" } }
        );
      }

      const html = await embedRes.text();

      // 4. Extract Real JS Script
      const jsMatch = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/);
      if (!jsMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Dynamic JS token generator not found." }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }

      const jsExpr = jsMatch[1];

      // 5. Query parameters extract karein
      const paramMatch = jsExpr.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/) ||
                         jsExpr.match(/get_video\?([^'"]+)/);

      if (!paramMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to locate token query parameters." }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }

      let gateUrl = `https://streamtape.to/get_video?${paramMatch[1]}`;
      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 6. Follow redirect with spoofed IP
      const gateRes = await fetch(gateUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
      });

      // Direct 302 redirect to final stream link
      return Response.redirect(gateRes.url, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },
};
