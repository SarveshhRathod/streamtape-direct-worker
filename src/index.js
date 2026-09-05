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
      // 1. Extract Video ID (handles both /v/ and /e/)
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      const browserHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
      };

      // 2. Fetch Embed HTML Page
      const embedRes = await fetch(embedUrl, { headers: browserHeaders });
      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json" } }
        );
      }

      const html = await embedRes.text();

      // 3. Extract Real Dynamic JS Expression
      const jsMatch = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/);
      if (!jsMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Dynamic JS token generator script not found." }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }

      const jsExpr = jsMatch[1];

      // 4. Extract Query Parameters directly (handles obfuscated domain names like 'xcdbeamtape.to')
      const paramMatch = jsExpr.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/);
      
      let queryString = null;
      if (paramMatch) {
        queryString = paramMatch[1];
      } else {
        const looseMatch = jsExpr.match(/get_video\?([^'"]+)/);
        if (looseMatch) {
          queryString = looseMatch[1];
        }
      }

      if (!queryString) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to locate token query parameters." }),
          { status: 500, headers: { "content-type": "application/json" } }
        );
      }

      // Build clean gate URL targeting working mirror domain
      let gateUrl = `https://streamtape.to/get_video?${queryString}`;
      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 5. Follow 302 Redirect to retrieve the final tapecontent CDN stream
      const gateRes = await fetch(gateUrl, {
        headers: {
          "User-Agent": browserHeaders["User-Agent"],
          "Referer": embedUrl,
        },
        redirect: "follow",
      });

      const finalCdnUrl = gateRes.url;

      // 6. Direct Playback: 302 Redirect browser/player to the final CDN MP4 stream
      return Response.redirect(finalCdnUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },
};
