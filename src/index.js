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

      // 2. Fetch Embed HTML
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
          JSON.stringify({ status: "error", message: "Video not found or file was deleted by Streamtape." }, null, 2),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      // 3. Dynamic Token Extraction
      let gateUrl = null;

      const subMatch = html.match(/\+\s*\(?['"]([^'"]+)['"]\)?\.substring\((\d+)\)/);
      const basePartMatch = html.match(/['"]((?:https:)?\/\/streamtape\.to\/get_video\?[^'"]+)['"]/);

      if (subMatch && basePartMatch) {
        let basePart = basePartMatch[1];
        if (basePart.startsWith("//")) basePart = "https:" + basePart;
        const rawToken = subMatch[1];
        const offset = parseInt(subMatch[2], 10);
        const token = rawToken.substring(offset);
        gateUrl = `${basePart}&token=${token}`;
      }

      if (!gateUrl) {
        const queryParamsMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+&token=[a-zA-Z0-9_\-]+)/);
        if (queryParamsMatch) {
          gateUrl = `https://streamtape.to/get_video?${queryParamsMatch[1]}`;
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to extract dynamic token from Streamtape." }, null, 2),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Resolve Final Tapecontent CDN Link
      // Direct redirect follow karte hain taaki final target pakad sakein
      const gateHeaders = {
        "User-Agent": browserHeaders["User-Agent"],
        "Accept": "*/*",
        "Referer": embedUrl,
      };

      let finalCdnUrl = null;

      // Method 1: Follow redirect automatically
      const followRes = await fetch(gateUrl, {
        headers: gateHeaders,
        redirect: "follow",
      });

      if (followRes.url && followRes.url.includes("tapecontent.net")) {
        finalCdnUrl = followRes.url;
      } else {
        // Method 2: Manual location check agar redirect follow na hua ho
        const manualRes = await fetch(gateUrl, {
          headers: gateHeaders,
          redirect: "manual",
        });
        const loc = manualRes.headers.get("location") || manualRes.headers.get("Location");
        if (loc) {
          finalCdnUrl = loc.startsWith("http") ? loc : ("https:" + (loc.startsWith("//") ? loc : "//" + loc));
        } else {
          finalCdnUrl = followRes.url;
        }
      }

      // 5. Pure Clean JSON Output
      return new Response(
        JSON.stringify({
          status: "success",
          video_id: videoId,
          gate_url: gateUrl,
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
