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

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": embedUrl,
      };

      // 2. Fetch Embed HTML Page
      const embedRes = await fetch(embedUrl, {
        headers: headers,
        redirect: "follow",
      });

      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const html = await embedRes.text();

      // Check if video was removed / deleted
      if (html.includes("Video not found") || html.includes("File was deleted")) {
        return new Response(
          JSON.stringify({ status: "error", message: "Video not found or has been deleted by Streamtape." }),
          { status: 404, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // 3. Extract Real Token via Accurate Script Parsing
      // Streamtape dynamic line looks like:
      // document.getElementById('...').innerHTML = "..." + ('...' + '...').substring(X) + ...
      let gateUrl = null;

      // Match the main video script block
      const scriptBlockMatch = html.match(/<script[^>]*>([\s\S]*?innerHTML\s*=[\s\S]*?)<\/script>/gi);

      if (scriptBlockMatch) {
        for (const script of scriptBlockMatch) {
          if (!script.includes("get_video")) continue;

          // Find base link: get_video?id=...&expires=...&ip=...
          const baseMatch = script.match(/["'](\/\/streamtape\.to\/get_video\?[^"']+)["']/);
          
          // Find token part: '...token=...' or '+ ('...' + '...').substring(...)
          const tokenPartMatch = script.match(/\+\s*\(?['"]([^'"]+)['"]\)?\.substring\((\d+)\)/);
          const simpleTokenMatch = script.match(/&token=([a-zA-Z0-9_\-]+)/);

          if (baseMatch) {
            let basePart = baseMatch[1];
            if (!basePart.startsWith("http")) {
              basePart = "https:" + basePart;
            }

            if (tokenPartMatch) {
              const rawString = tokenPartMatch[1];
              const sliceCount = parseInt(tokenPartMatch[2], 10);
              const validToken = rawString.substring(sliceCount);
              gateUrl = `${basePart}&token=${validToken}`;
              break;
            } else if (simpleTokenMatch) {
              gateUrl = `${basePart}&token=${simpleTokenMatch[1]}`;
              break;
            }
          }
        }
      }

      // Fallback: If custom slice pattern was not present, look for full reconstructed URL
      if (!gateUrl) {
        const directMatch = html.match(/["'](\/\/streamtape\.to\/get_video\?id=[^"']+)["']/);
        if (directMatch) {
          gateUrl = "https:" + directMatch[1];
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Failed to extract dynamic token from Streamtape."
          }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Hit Gate URL with mandatory Referer to fetch 302 location
      const gateHeaders = {
        "User-Agent": headers["User-Agent"],
        "Accept": "*/*",
        "Referer": embedUrl,
      };

      const gateRes = await fetch(gateUrl, {
        headers: gateHeaders,
        redirect: "manual",
      });

      // Streamtape returns HTTP 302 with Location header
      let finalStreamUrl = gateRes.headers.get("Location");

      // Agar direct 302 na mile to text check karein
      if (!finalStreamUrl) {
        const bodyText = await gateRes.text();
        return new Response(bodyText, {
          status: gateRes.status || 500,
          headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      if (!finalStreamUrl.startsWith("http")) {
        finalStreamUrl = "https:" + ("//" + finalStreamUrl.replace(/^\/+/, ""));
      }

      // 5. Direct 302 Redirect to video CDN
      return Response.redirect(finalStreamUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
