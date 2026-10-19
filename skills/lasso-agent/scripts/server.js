#!/data/data/com.termux/files/usr/bin/node
/**
 * Lasso Agent — Antigravity-Powered Visual Development Server & Bridge
 *
 * Runs the user's project (game, static site, or app) on localhost (default 8080),
 * automatically injects the Lasso Visual Overlay into the running app,
 * and bridges all visual selections, ⌘K prompts, and tasks directly to
 * Google Antigravity (agy) while preserving multi-turn session memory.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

// Use local ws module
const { WebSocketServer, WebSocket } = require(path.join(__dirname, "node_modules", "ws"));

const DEFAULT_PORT = parseInt(process.env.LASSO_AGENT_PORT || "8080", 10);
const PID_DIR = path.join(process.env.HOME || "", ".lasso");
const PID_FILE = path.join(PID_DIR, "lasso-agent.pid");
const STATE_FILE = path.join(PID_DIR, "lasso-agent-session.json");
const OVERLAY_FILE = path.join(__dirname, "..", "assets", "overlay.js");

try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch (_) {}

let activeProjectDir = process.env.LASSO_PROJECT_DIR || process.cwd();
let activeConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID || loadSavedConversationId() || "";
let activeModel = "gemini-3.8-flash-high";

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

// Create HTTP server
function createServer() {
  const server = http.createServer((req, res) => {
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
        conversationId: activeConversationId,
        model: activeModel,
      }));
      return;
    }

    // Resolve static file from activeProjectDir (e.g. ~/game)
    let filePath = path.join(activeProjectDir, pathname);

    // If directory, check index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // Fallback: check index.html in project root
      const fallbackIndex = path.join(activeProjectDir, "index.html");
      if (fs.existsSync(fallbackIndex)) {
        filePath = fallbackIndex;
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(`File not found: ${pathname} in ${activeProjectDir}`);
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    // If HTML: inject the Lasso Overlay & Live Reload script!
    if (ext === ".html" || ext === ".htm") {
      try {
        let html = fs.readFileSync(filePath, "utf8");
        const port = server.address() ? server.address().port : DEFAULT_PORT;
        
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
          html = html.replace("</head>", `${injection}</head>`);
        } else if (html.includes("</body>")) {
          html = html.replace("</body>", `${injection}</body>`);
        } else {
          html += injection;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
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
  });

  // Attach WebSocket Bridge to the same HTTP server
  const wss = new WebSocketServer({ server });

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
        const projectFiles = [];
        try {
          const files = fs.readdirSync(activeProjectDir);
          for (const f of files) {
            if (!f.startsWith(".") && f !== "node_modules") projectFiles.push(f);
          }
        } catch (_) {}
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
          const afterSnaps = snapshotFiles(activeProjectDir, projectFiles);
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
        // Auto reload game / page in browser!
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
function startListening(port) {
  const server = createServer();
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
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: actualPort, startTime: Date.now(), projectDir: activeProjectDir }));
    console.log(`[Lasso Agent] Serving project at http://127.0.0.1:${actualPort}`);
    console.log(`[Lasso Agent] Active Project: ${activeProjectDir}`);
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
