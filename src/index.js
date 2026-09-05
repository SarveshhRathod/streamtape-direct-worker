export default {
  async fetch(request, env, ctx) {
    // Enable CORS for all incoming requests (App / Web player)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");
    const outputFormat = requestUrl.searchParams.get("format") || "json";

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Video URL parameter missing.",
          usage: `${requestUrl.origin}/?url=https://streamtape.com/v/VIDEO_ID/...`
        }, null, 2),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    try {
      // 1. Extract Video ID from /v/ or /e/
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
      const browserHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
        "X-Forwarded-For": clientIp,
        "CF-Connecting-IP": clientIp,
      };

      // 2. Fetch Embed HTML Page (~50 KB data)
      const embedRes = await fetch(embedUrl, { headers: browserHeaders });
      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const html = await embedRes.text();

      // 3. Extract Real Dynamic Script
      const jsMatch = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/);
      if (!jsMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Token generator script not found in HTML." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const jsExpr = jsMatch[1];

      // 4. Extract Query Parameters (id, expires, ip, token)
      const paramMatch = jsExpr.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/) ||
                         jsExpr.match(/get_video\?([^'"]+)/);

      if (!paramMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Token query parameters missing." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let gateUrl = `https://streamtape.to/get_video?${paramMatch[1]}`;
      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 5. Follow 302 location to capture final tapecontent CDN stream
      const gateRes = await fetch(gateUrl, {
        headers: browserHeaders,
        redirect: "follow",
      });

      const finalCdnUrl = gateRes.url;

      // Agar redirect parameter diya ho to direct 302 redirect karein
      if (outputFormat === "redirect") {
        return Response.redirect(finalCdnUrl, 302);
      }

      // Default: Return high-speed JSON payload with final direct CDN URL
      return new Response(
        JSON.stringify({
          status: "success",
          video_id: videoId,
          cdn_url: finalCdnUrl,
          stream_url: finalCdnUrl,
          bandwidth_cost: "micro (~50KB)",
          generated_at: new Date().toISOString()
        }, null, 2),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate"
          }
        }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  },
};
