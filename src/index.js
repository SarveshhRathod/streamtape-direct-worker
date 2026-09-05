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
            "Content-Type": "application/json; charset=utf-8",
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
          { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      const clientIp = request.headers.get("CF-Connecting-IP") || 
                       request.headers.get("X-Real-IP") || 
                       "127.0.0.1";

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
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const html = await embedRes.text();

      if (html.includes("Video not found") || html.includes("File was deleted")) {
        return new Response(
          JSON.stringify({ status: "error", message: "Video not found or file was deleted by Streamtape." }),
          { status: 404, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      // 3. Exact Split & Slicing Token Engine
      let gateUrl = null;

      const scriptLines = html.match(/document\.getElementById\([^)]+\)\.innerHTML\s*=\s*[^;\n]+;/g) || [];
      const targetLines = scriptLines.filter(line => line.includes("get_video"));

      if (targetLines.length > 0) {
        // Streamtape hamesha aakhiri line me genuine link banata hai
        const lastLine = targetLines[targetLines.length - 1];

        // Part A: Prefix before the '+' sign (e.g. '//streamtape.to/get_video?id=A')
        const prefixMatch = lastLine.match(/innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+/);
        // Part B: String inside parentheses (e.g. 'xcd2Lkva8JqqC4bk&expires=...&token=...')
        const parenStrMatch = lastLine.match(/\+\s*(?:''\s*\+\s*)?\(\s*['"]([^'"]+)['"]\s*\)/);
        // Part C: All substring offsets in order
        const substringMatches = [...lastLine.matchAll(/\.substring\((\d+)\)/g)];

        if (prefixMatch && parenStrMatch) {
          const prefix = prefixMatch[1];
          let suffix = parenStrMatch[1];

          for (const m of substringMatches) {
            const offset = parseInt(m[1], 10);
            suffix = suffix.substring(offset);
          }

          let combined = prefix + suffix;
          if (combined.startsWith("//")) {
            combined = "https:" + combined;
          } else if (!combined.startsWith("http")) {
            combined = "https://" + combined.replace(/^\/+/, "");
          }

          gateUrl = combined;
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to evaluate dynamic gate link." }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 4. Resolve Final Tapecontent CDN Link
      const gateHeaders = {
        "User-Agent": browserHeaders["User-Agent"],
        "Accept": "*/*",
        "Referer": embedUrl,
      };

      const gateRes = await fetch(gateUrl, {
        headers: gateHeaders,
        redirect: "manual",
      });

      let finalCdnUrl = gateRes.headers.get("Location") || gateRes.headers.get("location");

      if (!finalCdnUrl) {
        const followRes = await fetch(gateUrl, {
          headers: gateHeaders,
          redirect: "follow",
        });
        finalCdnUrl = followRes.url;
      }

      if (!finalCdnUrl || finalCdnUrl.includes("streamtape.to/get_video")) {
        return new Response(
          JSON.stringify({
            status: "error",
            message: "Streamtape gate rejected the request.",
            resolved_gate_url: gateUrl
          }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!finalCdnUrl.startsWith("http")) {
        finalCdnUrl = "https:" + ("//" + finalCdnUrl.replace(/^\/+/, ""));
      }

      // 5. Direct 302 Redirect to the playable CDN stream
      return Response.redirect(finalCdnUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
