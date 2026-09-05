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

      // 2. Proxy Helper Function (HTTP Forwarding Proxy Support)
      const fetchViaProxy = async (target, headers = {}) => {
        // Agar proxy credentials set hain to proxy ke through bhejenge
        if (env.PROXY_HOST && env.PROXY_USER) {
          const authString = btoa(`${env.PROXY_USER}:${env.PROXY_PASS}`);
          return await fetch(target, {
            headers: {
              ...headers,
              "Proxy-Authorization": `Basic ${authString}`,
            },
            redirect: "follow",
          });
        }
        // Fallback agar proxy config empty ho
        return await fetch(target, { headers, redirect: "follow" });
      };

      const baseHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
      };

      // 3. Fetch Embed HTML via Fixed IP Proxy
      const embedRes = await fetchViaProxy(embedUrl, baseHeaders);
      if (!embedRes.ok) {
        return new Response(
          JSON.stringify({ status: "error", message: `Upstream error: HTTP ${embedRes.status}` }),
          { status: 502, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      const html = await embedRes.text();

      // 4. Multi-Strategy Token Harvester
      let gateUrl = null;

      // Strategy A: Direct script extract
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

      // Strategy B: Full HTML parameter scan
      if (!gateUrl) {
        const rawParamMatch = html.match(/get_video\?(id=[^&'"]+&expires=\d+&ip=[^&'"]+&token=[a-zA-Z0-9_\-]+)/);
        if (rawParamMatch) {
          gateUrl = `https://streamtape.to/get_video?${rawParamMatch[1]}`;
        }
      }

      if (!gateUrl) {
        return new Response(
          JSON.stringify({ status: "error", message: "Failed to extract dynamic token from embed page." }),
          { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }

      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // 5. Follow Gate Link via the SAME Fixed IP Proxy
      const gateRes = await fetchViaProxy(gateUrl, baseHeaders);
      const finalCdnUrl = gateRes.url;

      // 6. Direct 302 Playback to the final tapecontent stream
      return Response.redirect(finalCdnUrl, 302);

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
