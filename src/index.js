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
      // 1. Extract Video ID
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
          { status: 400, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      // User-Agent standard modern desktop chrome
      const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

      // 2. Fetch Embed HTML with session cookie extraction
      const initialHeaders = {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
      };

      const embedRes = await fetch(embedUrl, {
        headers: initialHeaders,
        redirect: "follow"
      });

      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // Collect session cookies if provided
      const rawCookie = embedRes.headers.get("set-cookie") || "";
      const cookieHeader = rawCookie.split(",").map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");

      const html = await embedRes.text();

      // 3. Robust Multi-Pattern Token Harvester
      let gateUrl = null;

      // Method A: Target script document.getElementById innerHTML
      const scriptMatches = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/g);
      if (scriptMatches) {
        for (const script of scriptMatches) {
          const match = script.match(/get_video\?([^'"]+)/);
          if (match) {
            let q = match[1].replace(/['"\);\s].*$/, "");
            if (q.includes("token=")) {
              gateUrl = `https://streamtape.to/get_video?${q}`;
              break;
            }
          }
        }
      }

      // Method B: Global scan for get_video parameters in HTML
      if (!gateUrl) {
        const fullParamMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+&token=[a-zA-Z0-9_\-]+)/);
        if (fullParamMatch) {
          gateUrl = `https://streamtape.to/get_video?${fullParamMatch[1]}`;
        }
      }

      // Method C: Obfuscated string concatenation ('&token=' + ...)
      if (!gateUrl) {
        const baseMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+)/);
        const tokenMatch = html.match(/['"]&token=([^'"]+)['"]/);
        if (baseMatch && tokenMatch) {
          gateUrl = `https://streamtape.to/get_video?${baseMatch[1]}&token=${tokenMatch[1]}`;
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Failed to extract dynamic token from embed page."
          }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Resolve CDN Location
      const gateHeaders = {
        "User-Agent": userAgent,
        "Accept": "*/*",
        "Referer": embedUrl,
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-origin"
      };

      if (cookieHeader) {
        gateHeaders["Cookie"] = cookieHeader;
      }

      // Use redirect: "manual" to grab the 302 location directly
      const gateRes = await fetch(gateUrl, {
        headers: gateHeaders,
        redirect: "manual",
      });

      let finalCdnUrl = gateRes.headers.get("Location");

      if (!finalCdnUrl) {
        // If not 302, follow redirect to inspect final destination
        const followRes = await fetch(gateUrl, {
          headers: gateHeaders,
          redirect: "follow",
        });
        finalCdnUrl = followRes.url;
      }

      if (!finalCdnUrl.startsWith("http")) {
        finalCdnUrl = "https:" + ("//" + finalCdnUrl.replace(/^\/+/, ""));
      }

      // 5. Check if upstream threw 403 unauthorized JSON
      if (finalCdnUrl.includes("streamtape.to/get_video")) {
        const textCheck = await gateRes.text();
        return new Response(textCheck, {
          status: gateRes.status || 403,
          headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      // 6. Direct 302 Redirect to video stream
      return Response.redirect(finalCdnUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
