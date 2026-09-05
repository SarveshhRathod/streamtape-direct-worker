export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Video URL missing.",
          usage: `${requestUrl.origin}/?url=https://streamtape.com/v/VIDEO_ID/...`
        }, null, 2),
        {
          status: 400,
          headers: { 
            "content-type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          },
        }
      );
    }

    try {
      // 1. Extract Video ID from /v/ or /e/
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
          { status: 400, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      // 2. Real User IP Capture & Forwarding Headers
      const clientIp = request.headers.get("CF-Connecting-IP") || 
                       request.headers.get("X-Real-IP") || 
                       "127.0.0.1";

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

      // 3. Fetch Embed HTML Page
      const embedRes = await fetch(embedUrl, { headers: upstreamHeaders });
      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const html = await embedRes.text();

      // 4. Extract Dynamic JS Script
      const jsMatch = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/);
      if (!jsMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Token generator script not found." }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const jsExpr = jsMatch[1];

      // 5. Extract Query Parameters (id, expires, ip, token)
      const paramMatch = jsExpr.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/) ||
                         jsExpr.match(/get_video\?([^'"]+)/);

      if (!paramMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Token query parameters missing." }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      let gateUrl = `https://streamtape.to/get_video?${paramMatch[1]}`;
      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 6. Follow Gate Redirect using user IP headers to get final CDN stream link
      const gateRes = await fetch(gateUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
      });

      const finalCdnUrl = gateRes.url;

      // 7. Direct Play: 302 Redirect direct to final tapecontent CDN stream
      return Response.redirect(finalCdnUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
