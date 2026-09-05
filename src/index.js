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
      // 1. Video ID extract karein
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

      // Capture cookies
      const rawCookie = embedRes.headers.get("set-cookie") || "";
      const cookieHeader = rawCookie.split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");

      const html = await embedRes.text();

      if (html.includes("Video not found") || html.includes("File was deleted")) {
        return new Response(
          JSON.stringify({ status: "error", message: "Video not found or deleted." }, null, 2),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      // 3. Dynamic Token Harvester
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
          JSON.stringify({ status: "error", message: "Failed to extract dynamic token." }, null, 2),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Resolve CDN Link via Range Header Probe
      // Streamtape HEAD request par redirect nahi deta; isliye GET with Range: bytes=0-0 bhejte hain
      const gateHeaders = {
        "User-Agent": browserHeaders["User-Agent"],
        "Accept": "*/*",
        "Referer": embedUrl,
        "Range": "bytes=0-0",
      };

      if (cookieHeader) {
        gateHeaders["Cookie"] = cookieHeader;
      }

      const streamProbe = await fetch(gateUrl, {
        method: "GET",
        headers: gateHeaders,
        redirect: "follow",
      });

      let finalCdnUrl = streamProbe.url;

      // Agar direct URL abhi bhi get_video hai, to response body check karein
      // (kuch cases me Streamtape redirect ke badle window.location ya intermediate URL deta hai)
      let debugInfo = "streamProbe ok";
      if (!finalCdnUrl.includes("tapecontent.net")) {
        const probeText = await streamProbe.text();
        const cdnInBody = probeText.match(/https?:\/\/[a-zA-Z0-9_\.\-]*tapecontent\.net[^\s"'<>]+/);
        if (cdnInBody) {
          finalCdnUrl = cdnInBody[0];
        } else {
          debugInfo = `Status: ${streamProbe.status}, Body snippet: ${probeText.slice(0, 150)}`;
        }
      }

      // 5. Output Final Clean JSON
      return new Response(
        JSON.stringify({
          status: "success",
          video_id: videoId,
          gate_url: gateUrl,
          direct_cdn_url: finalCdnUrl,
          debug: debugInfo,
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
