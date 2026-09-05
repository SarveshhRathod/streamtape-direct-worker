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
        "Accept-Language": "en-US,en;q=0.9",
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

      // 3. Multi-Strategy Dynamic Token Extraction
      let gateUrl = null;

      // Strategy 1: Substring obfuscation match
      // Pattern: ('xy...').substring(X)
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

      // Strategy 2: Direct innerHTML assignment search
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

      // Strategy 3: Global HTML parameter scan
      if (!gateUrl) {
        const queryParamsMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+&token=[a-zA-Z0-9_\-]+)/);
        if (queryParamsMatch) {
          gateUrl = `https://streamtape.to/get_video?${queryParamsMatch[1]}`;
        }
      }

      // Strategy 4: Fallback concatenation search
      if (!gateUrl) {
        const idExpIp = html.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+)/);
        const tokOnly = html.match(/['"](?:&|\?)token=([^'"]+)['"]/);
        if (idExpIp && tokOnly) {
          gateUrl = `https://streamtape.to/get_video?${idExpIp[1]}&token=${tokOnly[1]}`;
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

      // 4. Resolve Tapecontent CDN Location (Server side)
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

      // 5. DIRECT STREAM PLAYBACK (No Redirect to tapecontent)
      // Client Range Header forward karte hain taaki forward/rewind aur video scrubbing work kare
      const streamHeaders = new Headers();
      streamHeaders.set("User-Agent", upstreamHeaders["User-Agent"]);
      streamHeaders.set("Referer", embedUrl);

      const clientRange = request.headers.get("Range");
      if (clientRange) {
        streamHeaders.set("Range", clientRange);
      }

      // Worker directly fetches binary stream from CDN
      const videoPipe = await fetch(cdnStreamUrl, {
        headers: streamHeaders,
      });

      // Headers prepare karein for native video playback
      const responseHeaders = new Headers(videoPipe.headers);
      responseHeaders.set("Content-Type", "video/mp4");
      responseHeaders.set("Accept-Ranges", "bytes");
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Headers", "*");
      responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

      // Raw binary stream response client ko return karein
      return new Response(videoPipe.body, {
        status: videoPipe.status,
        statusText: videoPipe.statusText,
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
