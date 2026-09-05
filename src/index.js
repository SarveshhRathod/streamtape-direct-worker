export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
    };

    const requestUrl = new URL(request.url);
    const targetUrl = requestUrl.searchParams.get("url");

    if (!targetUrl) {
      return new Response(
        JSON.stringify({ status: "error", message: "Missing url param" }, null, 2),
        { status: 400, headers: corsHeaders }
      );
    }

    try {
      const idMatch = targetUrl.match(/\/(?:v|e)\/([a-zA-Z0-9]+)/);
      if (!idMatch) {
        return new Response(
          JSON.stringify({ status: "error", message: "Invalid URL" }, null, 2),
          { status: 400, headers: corsHeaders }
        );
      }

      const videoId = idMatch[1];
      const embedUrl = `https://streamtape.to/e/${videoId}`;

      const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
      const browserHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": embedUrl,
        "X-Forwarded-For": clientIp,
        "CF-Connecting-IP": clientIp,
      };

      const embedRes = await fetch(embedUrl, {
        headers: browserHeaders,
        redirect: "follow",
      });

      const html = await embedRes.text();

      // Debug Collector Object
      const debug = {
        html_length: html.length,
        is_deleted: html.includes("Video not found") || html.includes("File was deleted"),
        found_target_lines: [],
        last_line_raw: null,
        prefix_extracted: null,
        raw_string_extracted: null,
        substring_chain: [],
        sliced_string: null,
        assembled_gate_url: null,
      };

      // 1. Collect all script lines assigning innerHTML
      const scriptLines = html.match(/document\.getElementById\([^)]+\)\.innerHTML\s*=\s*[^;\n]+;/g) || [];
      debug.found_target_lines = scriptLines.filter(line => line.includes("get_video"));

      if (debug.found_target_lines.length > 0) {
        const lastLine = debug.found_target_lines[debug.found_target_lines.length - 1];
        debug.last_line_raw = lastLine;

        // Prefix match (e.g., '//stream' or '/streamt')
        const prefixMatch = lastLine.match(/innerHTML\s*=\s*['"]([^'"]+)['"]/);
        debug.prefix_extracted = prefixMatch ? prefixMatch[1] : null;

        // Raw string inside parenthesis: ('...tape.to/get_video?id=...')
        const rawStringMatch = lastLine.match(/\(\s*['"]([^'"]*tape\.to\/get_video\?[^'"]+)['"]\s*\)/);
        debug.raw_string_extracted = rawStringMatch ? rawStringMatch[1] : null;

        // Substring numbers
        const substringMatches = [...lastLine.matchAll(/\.substring\((\d+)\)/g)];
        debug.substring_chain = substringMatches.map(m => parseInt(m[1], 10));

        if (debug.raw_string_extracted) {
          let resolvedStr = debug.raw_string_extracted;
          for (const offset of debug.substring_chain) {
            resolvedStr = resolvedStr.substring(offset);
          }
          debug.sliced_string = resolvedStr;

          const pfx = debug.prefix_extracted || "//stream";
          let combined = pfx + resolvedStr;
          if (combined.startsWith("//")) {
            combined = "https:" + combined;
          } else if (!combined.startsWith("http")) {
            combined = "https://" + combined.replace(/^\/+/, "");
          }
          debug.assembled_gate_url = combined;
        }
      }

      // Return Complete Debug Trace
      return new Response(JSON.stringify(debug, null, 2), {
        status: 200,
        headers: corsHeaders,
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "error", error: err.message, stack: err.stack }, null, 2),
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
