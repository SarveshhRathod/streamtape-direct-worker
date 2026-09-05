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
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    }

    const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
    if (!idMatch) {
      return new Response(
        JSON.stringify({ status: "error", message: "Invalid Streamtape URL format." }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

    const videoId = idMatch[1];
    const embedUrl = `https://streamtape.to/e/${videoId}`;

    // Ye HTML page user ke browser me load hokar user ki original IP se token request execute karega
    const clientResolverHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Streaming Video...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body, html {
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
    }
    #status-box {
      text-align: center;
      padding: 20px;
    }
    .spinner {
      width: 42px;
      height: 42px;
      border: 3px solid rgba(255,255,255,0.2);
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #000;
      display: none;
    }
  </style>
</head>
<body>

  <div id="status-box">
    <div class="spinner"></div>
    <p id="msg">Resolving stream from your IP...</p>
  </div>

  <video id="player" controls autoplay playsinline preload="auto"></video>

  <script>
    const targetEmbed = "${embedUrl}";

    async function initClientStream() {
      const msg = document.getElementById("msg");
      const statusBox = document.getElementById("status-box");
      const player = document.getElementById("player");

      try {
        msg.innerText = "Fetching video token...";

        // User ke phone/browser se embed page read karte hain (CORS bypass proxy ke zariye)
        const fetchUrl = "https://api.allorigins.win/raw?url=" + encodeURIComponent(targetEmbed);
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error("Failed to load embed page");

        const html = await res.text();

        // Real JS token expression extract karein
        const jsMatch = html.match(/document\\.getElementById\\(['"][^'"]+['"]\\)\\.innerHTML\\s*=\\s*(.*?);/);
        if (!jsMatch) throw new Error("Token script not found");

        const jsExpr = jsMatch[1];
        const paramMatch = jsExpr.match(/get_video\\?(id=[^&'"]+&expires=[^&'"]+&ip=[^&'"]+&token=[^&'"]+)/) ||
                           jsExpr.match(/get_video\\?([^'"]+)/);

        if (!paramMatch) throw new Error("Token parameters missing");

        const finalGateUrl = "https://streamtape.to/get_video?" + paramMatch[1] + "&stream=1";

        msg.innerText = "Connecting to stream...";

        // User ki IP se video load
        player.src = finalGateUrl;
        player.style.display = "block";
        statusBox.style.display = "none";
        
        player.play().catch(() => {
          // Autoplay block hone par user control available rehta hai
        });

      } catch (err) {
        msg.innerText = "Playback error: " + err.message;
      }
    }

    window.addEventListener("DOMContentLoaded", initClientStream);
  </script>
</body>
</html>`;

    return new Response(clientResolverHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    });
  }
};
