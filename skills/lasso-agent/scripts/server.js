#!/data/data/com.termux/files/usr/bin/node
/**
 * Lasso Agent — Antigravity-Powered Visual Development Server & Bridge
 *
 * Runs the user's project (game, static site, or app) on localhost (default 8080),
 * automatically discovers web roots (root, web/, public/, dist/, etc.),
 * reverse-proxies backend dev servers & WebSockets (e.g. FastAPI, Vite, Express),
 * injects the Lasso Visual Overlay directly into the live app,
 * and bridges all visual selections, ⌘K prompts, and tasks directly to
 * Google Antigravity (agy) while preserving multi-turn session memory.
 */

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

// Use local ws module
const { WebSocketServer } = require(path.join(__dirname, "node_modules", "ws"));

const DEFAULT_PORT = parseInt(process.env.LASSO_AGENT_PORT || "8080", 10);
const PID_DIR = path.join(process.env.HOME || "", ".lasso");
const PID_FILE = path.join(PID_DIR, "lasso-agent.pid");
const STATE_FILE = path.join(PID_DIR, "lasso-agent-session.json");
const OVERLAY_FILE = path.join(__dirname, "..", "assets", "overlay.js");

try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch (_) {}

let activeProjectDir = process.env.LASSO_PROJECT_DIR || process.cwd();
let activeConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID || loadSavedConversationId() || "";
let activeModel = "gemini-3.8-flash-high";
let serverPort = DEFAULT_PORT;
let detectedBackendPort = null;

function loadSavedConversationId() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return data.conversationId || "";
    }
  } catch (_) {}
  return "";
}

function saveConversationId(id) {
  if (!id) return;
  activeConversationId = id;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      conversationId: id,
      projectDir: activeProjectDir,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (_) {}
}

// MIME types dictionary for game and web assets
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

// Candidate subdirectories containing index.html
const CANDIDATE_SUBDIRS = ["", "web", "public", "dist", "client", "frontend", "app", "src", "www", "build", "out"];

function findWebRoot(dir) {
  for (const sub of CANDIDATE_SUBDIRS) {
    const candidate = sub ? path.join(dir, sub) : dir;
    const candidateIndex = path.join(candidate, "index.html");
    if (fs.existsSync(candidateIndex) && !fs.statSync(candidateIndex).isDirectory()) {
      return candidate;
    }
  }
  return dir;
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/",
      timeout: 300
    }, (res) => {
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function detectBackendPort(projectDir, ownPort) {
  if (process.env.LASSO_BACKEND_PORT) {
    return parseInt(process.env.LASSO_BACKEND_PORT, 10);
  }

  // Check if project is termux-workspace or similar python app
  if (fs.existsSync(path.join(projectDir, "server", "main.py"))) {
    if (await probePort(8000)) return 8000;
    if (await probePort(24817)) return 24817;

    // If preview script exists but port is not up, try starting preview
    const previewScript = path.join(projectDir, "preview.sh");
    if (fs.existsSync(previewScript)) {
      try {
        execSync(`bash "${previewScript}" >/dev/null 2>&1`, { cwd: projectDir });
        await new Promise(r => setTimeout(r, 600));
        if (await probePort(8000)) return 8000;
      } catch (_) {}
    }
  }

  // Probe common dev server ports
  const candidatePorts = [3000, 5173, 8000, 24817, 4000, 5000].filter(p => p !== ownPort);
  for (const p of candidatePorts) {
    if (await probePort(p)) return p;
  }
  return null;
}

// Available Antigravity models
let cachedModels = null;
function getAvailableModels() {
  if (cachedModels && cachedModels.length > 0) return cachedModels;
  try {
    const stdout = execSync("agy models 2>/dev/null", { encoding: "utf8", timeout: 8000 });
    const lines = stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n");
    const models = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Fetching") || trimmed.includes("...")) continue;
      const parts = trimmed.split(/[\t]+|\s{2,}/);
      if (parts.length >= 2) {
        models.push({ id: parts[0].trim(), label: parts[1].trim(), provider: "antigravity" });
      } else if (parts[0].trim()) {
        models.push({ id: parts[0].trim(), label: parts[0].trim(), provider: "antigravity" });
      }
    }
    if (models.length > 0) {
      cachedModels = models;
      return models;
    }
  } catch (_) {}
  cachedModels = [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", provider: "google" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", provider: "google" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", provider: "anthropic" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", provider: "anthropic" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", provider: "openai" }
  ];
  return cachedModels;
}

// Recursive file scanner for accurate project diffs
function getProjectFiles(dir, maxDepth = 4) {
  const files = [];
  function scan(current, depth, prefix) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor" || entry.name === "__pycache__" || entry.name === "dist" || entry.name === "build") {
        continue;
      }
      const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        scan(path.join(current, entry.name), depth + 1, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }
  scan(dir, 1, "");
  return files;
}

// In-memory snapshots for safe Undo
const taskSnapshots = new Map();

function snapshotFiles(dir, files) {
  const snaps = [];
  for (const rel of files) {
    const full = path.join(dir, rel);
    try {
      if (fs.existsSync(full)) {
        snaps.push({ file: rel, content: fs.readFileSync(full, "utf8") });
      } else {
        snaps.push({ file: rel, content: null });
      }
    } catch (_) {}
  }
  return snaps;
}

function restoreFiles(dir, snaps) {
  for (const s of snaps) {
    const full = path.join(dir, s.file);
    try {
      if (s.content === null) {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, s.content, "utf8");
      }
    } catch (_) {}
  }
}

// Live reload SSE clients
const reloadClients = new Set();
function triggerReload() {
  for (const client of reloadClients) {
    try {
      client.write("data: reload\n\n");
    } catch (_) {
      reloadClients.delete(client);
    }
  }
}

// Inject Lasso Overlay & Reload snippet into HTML string
function injectLasso(html, port) {
  const injection = `
<!-- [Lasso Agent] Overlay & Live Reload Injection -->
<script src="/__lasso/overlay.js?bridgePort=${port}"></script>
<script>
  (function() {
    try {
      var es = new EventSource('/__lasso/reload-events');
      es.onmessage = function(e) {
        if (e.data === 'reload') {
          console.log('[lasso] Reloading page to show code changes...');
          window.location.reload();
        }
      };
    } catch(err) {}
  })();
</script>
`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${injection}</head>`);
  } else if (html.includes("</body>")) {
    return html.replace("</body>", `${injection}</body>`);
  } else {
    return html + injection;
  }
}

// HTTP Reverse Proxy to backend dev server
function proxyHttpRequest(req, res, targetPort, injectOverlay = false) {
  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
      origin: `http://127.0.0.1:${targetPort}`,
      referer: `http://127.0.0.1:${targetPort}/`,
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const isHtml = (proxyRes.headers["content-type"] || "").includes("text/html");

    if (injectOverlay && isHtml) {
      let body = "";
      proxyRes.on("data", chunk => body += chunk.toString("utf8"));
      proxyRes.on("end", () => {
        const injected = injectLasso(body, serverPort);
        const headers = { ...proxyRes.headers };
        headers["content-type"] = "text/html; charset=utf-8";
        headers["content-length"] = Buffer.byteLength(injected, "utf8");
        delete headers["content-encoding"];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(injected);
      });
      return;
    }

    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Bad Gateway: Unable to reach backend dev server on port " + targetPort);
  });

  req.pipe(proxyReq, { end: true });
}

// WebSocket Reverse Proxy to backend server (e.g. termux-workspace terminal)
function proxyWebSocket(req, clientSocket, head, targetPort) {
  const targetSocket = net.connect(targetPort, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    let hasOrigin = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      let v = req.rawHeaders[i + 1];
      if (k.toLowerCase() === "host") v = `127.0.0.1:${targetPort}`;
      if (k.toLowerCase() === "origin") {
        v = `http://127.0.0.1:${targetPort}`;
        hasOrigin = true;
      }
      raw += `${k}: ${v}\r\n`;
    }
    if (!hasOrigin) {
      raw += `Origin: http://127.0.0.1:${targetPort}\r\n`;
    }
    raw += "\r\n";
    targetSocket.write(raw);
    if (head && head.length > 0) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });

  targetSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => targetSocket.destroy());
}

// Request Handler for HTTP
function handleHttpRequest(req, res, webRoot) {
  const rawUrl = req.url || "/";
  const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // Live reload SSE endpoint
  if (pathname === "/__lasso/reload-events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }

  // Serve Lasso Overlay Bundle
  if (pathname === "/__lasso/overlay.js") {
    if (fs.existsSync(OVERLAY_FILE)) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(fs.readFileSync(OVERLAY_FILE));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Lasso overlay bundle not found.");
    }
    return;
  }

  // Status endpoint for health checks
  if (pathname === "/__lasso/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      projectDir: activeProjectDir,
      webRoot: webRoot,
      backendPort: detectedBackendPort,
      conversationId: activeConversationId,
      model: activeModel,
    }));
    return;
  }

  // If path is an API endpoint and backend exists, proxy to backend
  if ((pathname.startsWith("/api/") || pathname.startsWith("/ws/")) && detectedBackendPort) {
    proxyHttpRequest(req, res, detectedBackendPort);
    return;
  }

  // Resolve static file:
  // 1. First look in webRoot (e.g. web/ or public/)
  let filePath = path.join(webRoot, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  // 2. If not found in webRoot, look in activeProjectDir root
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallbackPath = path.join(activeProjectDir, pathname);
    if (fs.existsSync(fallbackPath) && !fs.statSync(fallbackPath).isDirectory()) {
      filePath = fallbackPath;
    } else if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isDirectory()) {
      const fallbackIndex = path.join(fallbackPath, "index.html");
      if (fs.existsSync(fallbackIndex) && !fs.statSync(fallbackIndex).isDirectory()) {
        filePath = fallbackIndex;
      }
    }
  }

  // 3. If still not found, check if backend port exists
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (detectedBackendPort) {
      proxyHttpRequest(req, res, detectedBackendPort, true);
      return;
    }

    // Fallback: check index.html in webRoot for SPA client routing
    const spaIndex = path.join(webRoot, "index.html");
    if (fs.existsSync(spaIndex) && !fs.statSync(spaIndex).isDirectory()) {
      filePath = spaIndex;
    } else {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;padding:2rem;background:#0d1117;color:#c9d1d9;">
        <h2>Lasso Agent: No index.html found</h2>
        <p>Could not find <code>index.html</code> in <code>${activeProjectDir}</code> or subdirectories (<code>web/</code>, <code>public/</code>, <code>dist/</code>).</p>
        <p>Make sure your project has an <code>index.html</code> or start a development server on port 8000, 3000, or 5173.</p>
      </body></html>`);
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // If HTML: inject the Lasso Overlay & Live Reload script!
  if (ext === ".html" || ext === ".htm") {
    try {
      const html = fs.readFileSync(filePath, "utf8");
      const injected = injectLasso(html, serverPort);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injected);
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to read HTML: " + err.message);
      return;
    }
  }

  // Serve other static assets (images, audio, js, css, etc.)
  try {
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Stream error: " + err.message);
  }
}

// Create HTTP server & WebSocket Bridge
function createServer(webRoot) {
  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, webRoot);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    // Route Lasso bridge connections to wss
    if (pathname === "/" || pathname.startsWith("/__lasso")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    // Route project backend WebSocket connections (e.g. /ws/terminal) to detected backend
    if (detectedBackendPort) {
      proxyWebSocket(req, socket, head, detectedBackendPort);
      return;
    }

    socket.destroy();
  });

  wss.on("connection", (ws) => {
    // Send configuration to overlay on connection
    const models = getAvailableModels().map(m => ({
      id: m.id,
      label: m.label,
      provider: m.provider || "antigravity",
      locked: false,
    }));

    ws.send(JSON.stringify({
      type: "config",
      apiKeyConfigured: true,
      agentConfigured: true,
      models,
      collab: null,
      user: { name: "Lasso Developer", email: "antigravity@local" }
    }));

    ws.on("message", async (data) => {
      let msg = {};
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch (_) {
        return;
      }

      if (msg.type === "hello") {
        ws.send(JSON.stringify({
          type: "config",
          apiKeyConfigured: true,
          agentConfigured: true,
          models,
          collab: null,
        }));
        return;
      }

      // Handle Task / Prompt / Edit request
      if (msg.type === "edit" || msg.type === "oneshot" || msg.type === "ask") {
        const taskId = msg.taskId || `task-${Date.now()}`;
        const instruction = msg.instruction || msg.prompt || "";
        const model = msg.model || activeModel;

        if (!instruction.trim()) return;

        ws.send(JSON.stringify({
          type: "agent_status",
          taskId,
          status: "thinking",
          message: "Antigravity is reasoning on " + path.basename(activeProjectDir) + "...",
        }));

        // Take pre-edit snapshot of all project files
        const projectFiles = getProjectFiles(activeProjectDir);
        const beforeSnaps = snapshotFiles(activeProjectDir, projectFiles);
        taskSnapshots.set(taskId, beforeSnaps);

        // Prepare Antigravity prompt with element / project context
        let fullPrompt = instruction;
        if (msg.element) {
          fullPrompt += `\n\nTarget Element: <${msg.element.tag}> ${msg.element.label || ""}\nSource Hint: ${msg.element.sourceHint || ""}`;
        }
        fullPrompt += `\n\nImportant: You are modifying files directly in ${activeProjectDir}. Please edit the necessary files cleanly to achieve the desired result.`;

        const args = [
          "-p", fullPrompt,
          "--output-format", "stream-json",
          "--mode", "accept-edits",
          "--dangerously-skip-permissions"
        ];
        if (model) args.push("--model", model);
        if (activeConversationId) args.push("--conversation", activeConversationId);

        const child = spawn("agy", args, {
          cwd: activeProjectDir,
          env: { ...process.env, LASSO_ORCHESTRATOR: "1" }
        });

        let stdoutBuffer = "";

        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString("utf8");
          const lines = stdoutBuffer.split("\n");
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            try {
              const event = JSON.parse(trimmed);
              if (event.conversation_id) {
                saveConversationId(event.conversation_id);
              }

              if (event.event === "step_update") {
                const step = event.step_update;
                if (step?.step_type === "agent_response" && step.text_delta) {
                  ws.send(JSON.stringify({
                    type: "agent_status",
                    taskId,
                    status: "thinking",
                    message: step.text_delta.slice(0, 150),
                  }));
                } else if (step?.step_type === "tool") {
                  const toolName = step.tool_name || "tool";
                  ws.send(JSON.stringify({
                    type: "agent_status",
                    taskId,
                    status: "working",
                    message: `Executing ${toolName}...`,
                  }));
                }
              }
            } catch (_) {}
          }
        });

        child.on("close", () => {
          // Detect changes by comparing before and after files
          const afterFiles = getProjectFiles(activeProjectDir);
          const allFiles = Array.from(new Set([...projectFiles, ...afterFiles]));
          const afterSnaps = snapshotFiles(activeProjectDir, allFiles);
          const changes = [];

          for (const after of afterSnaps) {
            const before = beforeSnaps.find(b => b.file === after.file);
            if (!before || before.content !== after.content) {
              changes.push({
                filePath: after.file,
                oldString: before?.content || "",
                newString: after.content || "",
                operation: !before ? "created" : "modified",
              });
            }
          }

          if (changes.length > 0) {
            // Send review payload to overlay
            ws.send(JSON.stringify({
              type: "agent_status",
              taskId,
              status: "review",
              message: "Review proposed changes",
              changes,
            }));
          } else {
            ws.send(JSON.stringify({
              type: "applied",
              taskId,
              message: "Task completed.",
            }));
            triggerReload();
          }
        });

        child.on("error", (err) => {
          ws.send(JSON.stringify({
            type: "agent_status",
            taskId,
            status: "error",
            message: "Failed to invoke Antigravity: " + err.message,
          }));
        });
      }

      // Handle Apply (User clicked Accept)
      if (msg.type === "apply") {
        const taskId = msg.taskId;
        ws.send(JSON.stringify({
          type: "applied",
          taskId,
          message: "Changes applied successfully!",
        }));
        setTimeout(triggerReload, 300);
      }

      // Handle Undo (User clicked Revert)
      if (msg.type === "undo") {
        const taskId = msg.taskId;
        const snaps = taskSnapshots.get(taskId);
        if (snaps) {
          restoreFiles(activeProjectDir, snaps);
          taskSnapshots.delete(taskId);
        }
        ws.send(JSON.stringify({
          type: "agent_status",
          taskId,
          status: "stopped",
          message: "Changes reverted.",
        }));
        setTimeout(triggerReload, 300);
      }
    });
  });

  return server;
}

// Port probing & launch
async function startListening(port) {
  serverPort = port;
  const webRoot = findWebRoot(activeProjectDir);
  detectedBackendPort = await detectBackendPort(activeProjectDir, port);

  const server = createServer(webRoot);
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Lasso Agent] Port ${port} is in use, trying ${port + 1}...`);
      startListening(port + 1);
    } else {
      console.error("[Lasso Agent] Server error:", err);
      process.exit(1);
    }
  });

  server.once("listening", () => {
    const address = server.address();
    const actualPort = typeof address === "object" ? address.port : port;
    serverPort = actualPort;
    fs.writeFileSync(PID_FILE, JSON.stringify({
      pid: process.pid,
      port: actualPort,
      startTime: Date.now(),
      projectDir: activeProjectDir,
      webRoot,
      backendPort: detectedBackendPort,
    }));
    console.log(`[Lasso Agent] Serving project at http://127.0.0.1:${actualPort}`);
    console.log(`[Lasso Agent] Active Project: ${activeProjectDir}`);
    console.log(`[Lasso Agent] Web Root: ${webRoot}`);
    if (detectedBackendPort) {
      console.log(`[Lasso Agent] Backend Dev Server Proxied: 127.0.0.1:${detectedBackendPort}`);
    }
  });

  server.listen(port, "127.0.0.1");
}

// Clean shutdown
process.on("SIGTERM", () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
});
process.on("SIGINT", () => {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
});

startListening(DEFAULT_PORT);
