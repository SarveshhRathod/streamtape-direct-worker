export default {
  async fetch(request, env, ctx) {
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

      // 3. Extract Token via Slice Logic
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
          JSON.stringify({ status: "error", message: "Failed to extract dynamic token from Streamtape." }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Follow redirect manually to get final tapecontent CDN stream
      const gateRes = await fetch(gateUrl, {
        headers: {
          "User-Agent": browserHeaders["User-Agent"],
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

      // Agar direct playback parameter manga ho ya pipe fail ho raha ho
      // Streamtape CDN se handshake check karein
      const testHeaders = {
        "User-Agent": browserHeaders["User-Agent"],
        "Referer": embedUrl,
      };
      
      const clientRange = request.headers.get("range");
      if (clientRange) {
        testHeaders["Range"] = clientRange;
      }

      const cdnRes = await fetch(cdnStreamUrl, {
        headers: testHeaders,
      });

      // Agar Cloudflare IP ko Tapecontent ne 403 de diya:
      if (cdnRes.status === 403 || cdnRes.status === 401) {
        // Fallback: Browser ko direct CDN URL par redirect kar do
        // User ke mobile browser ka real IP match ho jayega aur video chal jayegi
        return Response.redirect(cdnStreamUrl, 302);
      }

      // Agar stream OK hai to pipe karein
      const responseHeaders = new Headers(cdnRes.headers);
      responseHeaders.set("Content-Type", "video/mp4");
      responseHeaders.set("Accept-Ranges", "bytes");
      responseHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(cdnRes.body, {
        status: cdnRes.status,
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
