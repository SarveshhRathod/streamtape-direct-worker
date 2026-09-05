export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "Video URL parameter missing.",
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

      const clientIp = request.headers.get("CF-Connecting-IP") || 
                       request.headers.get("X-Real-IP") || 
                       "127.0.0.1";

      const upstreamHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
        "X-Forwarded-For": clientIp,
        "CF-Connecting-IP": clientIp,
      };

      // 2. Fetch Embed HTML Page
      const embedRes = await fetch(embedUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
      });

      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const html = await embedRes.text();

      if (html.includes("Video not found") || html.includes("File was deleted")) {
        return new Response(
          JSON.stringify({ status: "error", message: "Video not found or file was deleted by Streamtape." }),
          { status: 404, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
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
        const innerMatch = html.match(/innerHTML\s*=\s*(.*?);/g);
        if (innerMatch) {
          for (const line of innerMatch) {
            if (!line.includes("get_video")) continue;
            const fullLink = line.match(/["']((?:https:)?\/\/streamtape\.to\/get_video\?[^"']+)["']/);
            if (fullLink) {
              let lk = fullLink[1];
              if (lk.startsWith("//")) lk = "https:" + lk;
              gateUrl = lk;
              break;
            }
          }
        }
      }

      if (!gateUrl) {
        const queryParamsMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+&token=[a-zA-Z0-9_\-]+)/);
        if (queryParamsMatch) {
          gateUrl = `https://streamtape.to/get_video?${queryParamsMatch[1]}`;
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

      // 4. Resolve Final Tapecontent CDN URL
      const gateRes = await fetch(gateUrl, {
        headers: {
          "User-Agent": upstreamHeaders["User-Agent"],
          "Accept": "*/*",
          "Referer": embedUrl,
        },
        redirect: "manual",
      });

      let cdnStreamUrl = gateRes.headers.get("Location");
      if (!cdnStreamUrl) {
        cdnStreamUrl = gateRes.url;
      }

      if (!cdnStreamUrl.startsWith("http")) {
        cdnStreamUrl = "https:" + ("//" + cdnStreamUrl.replace(/^\/+/, ""));
      }

      // 5. Build Upstream Stream Request with Browser Range
      const streamReqHeaders = {
        "User-Agent": upstreamHeaders["User-Agent"],
        "Referer": embedUrl,
      };

      const range = request.headers.get("range");
      if (range) {
        streamReqHeaders["Range"] = range;
      }

      const cdnRes = await fetch(cdnStreamUrl, {
        headers: streamReqHeaders,
        redirect: "follow",
      });

      // Agar upstream 403 fek raha ho to error return karein taaki broken screen na aaye
      if (cdnRes.status === 403) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Streamtape CDN returned 403 Forbidden. IP lock active.",
            direct_cdn_url: cdnStreamUrl
          }),
          { status: 403, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // 6. Deliver Proper Video Headers for Chrome/ExoPlayer
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "video/mp4");
      responseHeaders.set("Accept-Ranges", "bytes");
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      if (cdnRes.headers.has("Content-Length")) {
        responseHeaders.set("Content-Length", cdnRes.headers.get("Content-Length"));
      }
      if (cdnRes.headers.has("Content-Range")) {
        responseHeaders.set("Content-Range", cdnRes.headers.get("Content-Range"));
      }

      return new Response(cdnRes.body, {
        status: cdnRes.status,
        statusText: cdnRes.statusText,
        headers: responseHeaders,
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
