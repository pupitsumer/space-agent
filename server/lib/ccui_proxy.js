import http from "node:http";
import net from "node:net";

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 3001;
const TARGET      = `http://${TARGET_HOST}:${TARGET_PORT}`;
const MOUNT       = "/cc-ui";
// Path as seen by the browser (nginx adds /space_agent/ prefix)
const EXTERNAL    = "/space_agent/cc-ui";

const TEXT_TYPES = ["text/html", "text/javascript", "application/javascript", "text/css"];

function rewriteBody(text) {
  return text
    .replaceAll('href="/assets/',    `href="${EXTERNAL}/assets/`)
    .replaceAll('href="/favicon',    `href="${EXTERNAL}/favicon`)
    .replaceAll('href="/manifest',   `href="${EXTERNAL}/manifest`)
    .replaceAll('href="/icons/',     `href="${EXTERNAL}/icons/`)
    .replaceAll('src="/assets/',     `src="${EXTERNAL}/assets/`)
    .replaceAll('content="/assets/', `content="${EXTERNAL}/assets/`)
    .replaceAll('"/api/',            `"${EXTERNAL}/api/`)
    .replaceAll("'/api/",            `'${EXTERNAL}/api/`)
    // Fix React Router basename: pG() detects proxy path to set router basename
    .replaceAll(
      'function pG(){const t=window.location.pathname.match(/^(\\/clients\\/[^/]+\\/proxy)/);return t?t[1]:""}',
      `function pG(){return"${EXTERNAL}"}`
    )
    // Note: /ws and /shell WebSocket paths are handled directly by nginx (exact match locations)
}

export function isCcuiPath(pathname) {
  return pathname === MOUNT || pathname.startsWith(MOUNT + "/");
}

// Static assets that should bypass Space Agent auth (loaded by the browser before auth cookie)
const PUBLIC_SUFFIXES = ["/manifest.json", "/favicon.svg", "/favicon.png", "/sw.js"];
export function isCcuiPublic(pathname) {
  return PUBLIC_SUFFIXES.some((s) => pathname.endsWith(s)) || pathname.startsWith(MOUNT + "/icons/");
}

export async function proxyCcuiRequest(req, res) {
  const targetPath = req.url.replace(/^\/cc-ui/, "") || "/";

  await new Promise((resolve) => {
    const proxyHeaders = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}`, "accept-encoding": "identity" };

    const proxyReq = http.request(TARGET + targetPath, { method: req.method, headers: proxyHeaders }, (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isText = TEXT_TYPES.some((t) => contentType.includes(t));

      const headers = { ...proxyRes.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];

      if (isText) {
        const chunks = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          const body = Buffer.from(rewriteBody(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(proxyRes.statusCode, { ...headers, "content-length": body.byteLength, "cache-control": "no-store" });
          res.end(body);
          resolve();
        });
      } else {
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
        proxyRes.on("end", resolve);
      }

      proxyRes.on("error", resolve);
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) { res.writeHead(502); res.end("Claude Code UI unreachable"); }
      resolve();
    });

    req.pipe(proxyReq);
  });
}

// WebSocket tunnel: proxies upgrade requests for /cc-ui/ws and /cc-ui/shell
export function setupCcuiWsProxy(server) {
  server.on("upgrade", (req, socket, head) => {
    if (!isCcuiPath(new URL(req.url, "http://x").pathname)) return;

    const targetPath = req.url.replace(/^\/cc-ui/, "") || "/";
    const reqLine = `${req.method} ${targetPath} HTTP/1.1\r\n`;
    const headers = Object.entries(req.headers)
      .filter(([k]) => k !== "host")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    const tunnel = net.createConnection(TARGET_PORT, TARGET_HOST, () => {
      tunnel.write(`${reqLine}host: ${TARGET_HOST}:${TARGET_PORT}\r\n${headers}\r\n\r\n`);
      if (head?.length) tunnel.write(head);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    });

    tunnel.on("error", () => socket.destroy());
    socket.on("error", () => tunnel.destroy());
  });
}
