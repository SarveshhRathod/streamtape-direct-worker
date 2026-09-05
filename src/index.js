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

      const embedRes = await fetch(embedUrl, { headers: browserHeaders });
      if (!embedRes.ok) {
        return new Response(`Upstream fetch failed: ${embedRes.status}`, { status: 502 });
      }

      const html = await embedRes.text();

      // Real token extract karein
      const jsMatch = html.match(/document\.getElementById\(['"][^'"]+['"]\)\.innerHTML\s*=\s*(.*?);/);
      if (!jsMatch) {
        return new Response("Dynamic JS token not found.", { status: 500 });
      }

      const jsExpr = jsMatch[1];
      const paramMatch = jsExpr.match(/get_video\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/) ||
                         jsExpr.match(/get_video\?([^'"]+)/);

      if (!paramMatch) {
        return new Response("Parameters missing.", { status: 500 });
      }

      let gateUrl = `https://streamtape.to/get_video?${paramMatch[1]}`;
      if (!gateUrl.includes("stream=1")) {
        gateUrl += "&stream=1";
      }

      // Clean, ad-free standalone HTML5 web player return karein
      const playerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Direct Player</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background-color: #0b0f19;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      font-family: system-ui, -apple-system, sans-serif;
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
    }
  </style>
</head>
<body>
  <video id="vPlayer" controls autoplay playsinline preload="auto">
    <source src="${gateUrl}" type="video/mp4">
    Your browser does not support HTML5 video streaming.
  </video>
</body>
</html>`;

      return new Response(playerHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", message: err.message }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
  },
};
