export default {
  async fetch(request, env, ctx) {
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

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Video URL parameter missing.",
          usage: `${requestUrl.origin}/?url=https://streamtape.com/e/VIDEO_ID/`
        }, null, 2),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    try {
      // 1. Extract Video ID
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }, null, 2),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
      const browserHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": embedUrl,
        "X-Forwarded-For": clientIp,
        "CF-Connecting-IP": clientIp,
      };

      // 2. Fetch Embed HTML Page
      const embedRes = await fetch(embedUrl, {
        headers: browserHeaders,
        redirect: "follow",
      });

      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }, null, 2),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      const html = await embedRes.text();

      if (html.includes("Video not found") || html.includes("File was deleted")) {
        return new Response(
          JSON.stringify({ status: "error", message: "Video not found or deleted." }, null, 2),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      // 3. Target the Real 'robotlink' Line Only
      let gateUrl = null;

      // Extract specifically the robotlink line from the bottom script
      const robotMatches = [...html.matchAll(/document\.getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*(.*?);/g)];
      
      if (robotMatches.length > 0) {
        // Take the last assignment (the real one)
        const lastExpr = robotMatches[robotMatches.length - 1][1];

        // Match string: '//stream' + ('xcdtape.to/get_video?id=...&token=...').substring(2).substring(1)
        const strMatch = lastExpr.match(/\(\s*['"]([^'"]+tape\.to\/get_video\?[^'"]+)['"]\s*\)/);
        const slices = [...lastExpr.matchAll(/\.substring\((\d+)\)/g)].map(m => parseInt(m[1], 10));

        if (strMatch) {
          let resolved = strMatch[1];
          for (const s of slices) {
            resolved = resolved.substring(s);
          }
          gateUrl = "https://" + resolved.replace(/^\/+/, "");
        }
      }

      // Fallback parser if robotlink structure alters slightly
      if (!gateUrl) {
        const anyScriptTokens = [...html.matchAll(/\(\s*['"]([^'"]+tape\.to\/get_video\?[^'"]+)['"]\s*\)((\.substring\(\d+\))+)/g)];
        if (anyScriptTokens.length > 0) {
          const last = anyScriptTokens[anyScriptTokens.length - 1];
          let resolved = last[1];
          const innerSlices = [...last[2].matchAll(/\.substring\((\d+)\)/g)].map(m => parseInt(m[1], 10));
          for (const s of innerSlices) {
            resolved = resolved.substring(s);
          }
          gateUrl = "https://" + resolved.replace(/^\/+/, "");
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to extract real robotlink token." }, null, 2),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Follow gate URL with Referer to fetch final .tapecontent.net CDN Link
      const gateHeaders = {
        "User-Agent": browserHeaders["User-Agent"],
        "Accept": "*/*",
        "Referer": embedUrl,
      };

      const gateRes = await fetch(gateUrl, {
        headers: gateHeaders,
        redirect: "follow",
      });

      const finalCdnUrl = gateRes.url;

      // 5. Output Pure Clean JSON
      return new Response(
        JSON.stringify({
          status: "success",
          video_id: videoId,
          real_gate_url: gateUrl,
          direct_cdn_url: finalCdnUrl,
          timestamp: new Date().toISOString()
        }, null, 2),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }, null, 2),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
      );
    }
  },
};
