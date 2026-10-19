#!/data/data/com.termux/files/usr/bin/node
/**
 * Lasso Agent - Web Interface & Antigravity Bridge Server
 * Runs on 127.0.0.1:8080 (or next free port)
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync, exec } = require("node:child_process");

const DEFAULT_PORT = parseInt(process.env.LASSO_AGENT_PORT || "8080", 10);
const PID_DIR = path.join(process.env.HOME || "", ".lasso");
const PID_FILE = path.join(PID_DIR, "lasso-agent.pid");
const STATE_FILE = path.join(PID_DIR, "lasso-agent-session.json");

// Ensure .lasso dir
try { fs.mkdirSync(PID_DIR, { recursive: true }); } catch (_) {}

// Active state
let activeProjectDir = process.env.LASSO_PROJECT_DIR || process.cwd();
let activeConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID || loadSavedConversationId() || "";
let activeModel = "gemini-3.8-flash-high";
let isRunningTask = false;

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
  activeConversationId = id;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      conversationId: id,
      projectDir: activeProjectDir,
      updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (_) {}
}

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
        models.push({ id: parts[0].trim(), label: parts[1].trim() });
      } else if (parts[0].trim()) {
        models.push({ id: parts[0].trim(), label: parts[0].trim() });
      }
    }
    if (models.length > 0) {
      cachedModels = models;
      return models;
    }
  } catch (_) {}
  cachedModels = [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" }
  ];
  return cachedModels;
}

// Git helpers
function getGitStatus(cwd) {
  try {
    const status = execSync("git status --short 2>/dev/null", { cwd, encoding: "utf8" });
    const diff = execSync("git diff 2>/dev/null", { cwd, encoding: "utf8" });
    return {
      isRepo: true,
      hasChanges: Boolean(status.trim()),
      statusLines: status.split("\n").filter(Boolean),
      diff: diff.slice(0, 10000) // cap size
    };
  } catch (_) {
    return { isRepo: false, hasChanges: false, statusLines: [], diff: "" };
  }
}

// HTML UI
function renderHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lasso Agent — Visual Code Editor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card: #111827;
      --card-border: #1f2937;
      --accent: #6366f1;
      --accent-hover: #4f46e5;
      --accent-glow: rgba(99, 102, 241, 0.25);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: rgba(17, 24, 39, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 1.15rem;
      letter-spacing: -0.02em;
    }
    .brand-badge {
      font-size: 0.7rem;
      background: var(--accent-glow);
      color: #818cf8;
      border: 1px solid #4338ca;
      padding: 2px 8px;
      border-radius: 9999px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 0.85rem;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #1f2937;
      padding: 4px 10px;
      border-radius: 6px;
      color: var(--text-muted);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    .main-container {
      display: grid;
      grid-template-columns: 320px 1fr;
      flex: 1;
      height: calc(100vh - 61px);
    }
    @media (max-width: 860px) {
      .main-container { grid-template-columns: 1fr; height: auto; }
    }
    aside {
      background: var(--card);
      border-right: 1px solid var(--card-border);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      overflow-y: auto;
    }
    .section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      font-weight: 700;
      margin-bottom: 8px;
    }
    .select-box, input[type="text"] {
      width: 100%;
      background: #1f2937;
      border: 1px solid #374151;
      color: var(--text);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.85rem;
      outline: none;
      transition: border 0.15s;
    }
    .select-box:focus, input[type="text"]:focus {
      border-color: var(--accent);
    }
    .btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 9px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.15s, transform 0.1s;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:active { transform: scale(0.98); }
    .btn-secondary {
      background: #1f2937;
      color: var(--text);
      border: 1px solid #374151;
    }
    .btn-secondary:hover { background: #374151; }
    .btn-danger { background: #991b1b; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-success { background: #065f46; }
    .btn-success:hover { background: #047857; }
    
    .workspace-area {
      display: flex;
      flex-direction: column;
      background: var(--bg);
      overflow: hidden;
    }
    .prompt-container {
      background: var(--card);
      border-bottom: 1px solid var(--card-border);
      padding: 16px 24px;
    }
    .prompt-box {
      display: flex;
      gap: 12px;
      position: relative;
    }
    .prompt-box textarea {
      flex: 1;
      background: #0b0f19;
      border: 1px solid #374151;
      border-radius: 8px;
      color: var(--text);
      padding: 12px 16px;
      font-size: 0.95rem;
      font-family: inherit;
      resize: vertical;
      min-height: 70px;
      max-height: 250px;
      outline: none;
      transition: border 0.2s, box-shadow 0.2s;
    }
    .prompt-box textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .prompt-actions {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 8px;
    }
    .content-area {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 16px;
    }
    .stream-feed {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      background: #030712;
      border: 1px solid #1f2937;
      border-radius: 6px;
      padding: 16px;
      min-height: 140px;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      color: #d1d5db;
    }
    .feed-tag {
      color: #818cf8;
      font-weight: 600;
    }
    .diff-viewer {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.82rem;
      background: #030712;
      border: 1px solid #1f2937;
      border-radius: 6px;
      padding: 14px;
      overflow-x: auto;
      max-height: 280px;
      color: #e5e7eb;
      white-space: pre-wrap;
    }
    .diff-add { color: #34d399; background: rgba(52, 211, 153, 0.1); }
    .diff-del { color: #f87171; background: rgba(248, 113, 113, 0.1); }
    .app-preview-frame {
      width: 100%;
      height: 380px;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      background: #ffffff;
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <span>🎯 Lasso Agent</span>
      <span class="brand-badge">Antigravity Native</span>
    </div>
    <div class="status-bar">
      <div class="status-pill">
        <span class="dot" id="statusDot"></span>
        <span id="sessionStatus">Connected to Antigravity</span>
      </div>
      <button class="btn btn-secondary" onclick="resetSession()" title="Start a clean session with new memory">🔄 New Session</button>
    </div>
  </header>

  <div class="main-container">
    <aside>
      <div>
        <div class="section-title">Antigravity AI Model</div>
        <select class="select-box" id="modelSelect" onchange="updateModel()">
          <option value="gemini-3.8-flash-high">Gemini 3.8 Flash (High)</option>
          <option value="gemini-3.8-flash-medium">Gemini 3.8 Flash (Medium)</option>
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Thinking)</option>
          <option value="claude-opus-4-6-thinking">Claude Opus 4.6 (Thinking)</option>
          <option value="gpt-oss-120b-medium">GPT-OSS 120B (Medium)</option>
        </select>
      </div>

      <div>
        <div class="section-title">Project Directory</div>
        <div style="font-size: 0.8rem; font-family: 'JetBrains Mono', monospace; word-break: break-all; color: #9ca3af; background: #030712; padding: 8px; border-radius: 6px;" id="projectPath">
          ...
        </div>
      </div>

      <div>
        <div class="section-title">Session Context Memory</div>
        <div style="font-size: 0.78rem; color: #9ca3af; margin-bottom: 8px;" id="memoryInfo">
          Multi-turn memory preserves your project architecture and previous edits.
        </div>
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; color: #6ee7b7; background: #064e3b33; padding: 6px; border-radius: 4px; word-break: break-all;" id="convId">
          Session ID: Initializing...
        </div>
      </div>

      <div>
        <div class="section-title">Live App Preview (URL)</div>
        <div style="display: flex; gap: 6px;">
          <input type="text" id="previewUrl" value="http://localhost:3000" placeholder="http://localhost:3000">
          <button class="btn btn-secondary" onclick="loadPreview()">Load</button>
        </div>
      </div>
    </aside>

    <main class="workspace-area">
      <div class="prompt-container">
        <div class="prompt-box">
          <textarea id="promptInput" placeholder="What would you like Lasso Agent to build or change? (e.g. 'Add a responsive hero section with a dark mode toggle')"></textarea>
          <div class="prompt-actions">
            <button class="btn" id="sendBtn" onclick="sendPrompt()">🚀 Execute Task</button>
          </div>
        </div>
      </div>

      <div class="content-area">
        <!-- Live Action Stream -->
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div class="section-title" style="margin-bottom: 0;">⚡ Antigravity Live Stream & Reasoning</div>
            <span id="taskSpinner" style="font-size: 0.8rem; color: var(--accent); display: none;">⏳ Working...</span>
          </div>
          <div class="stream-feed" id="streamFeed">Ready for instructions. Type a task above and click Execute.</div>
        </div>

        <!-- Diff Review Panel -->
        <div class="card" id="diffCard" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div class="section-title" style="margin-bottom: 0;">🔍 Review Changes (Workspace Guard)</div>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-success" onclick="acceptChanges()">✓ Accept Changes</button>
              <button class="btn btn-danger" onclick="rejectChanges()">✗ Revert / Undo</button>
            </div>
          </div>
          <div class="diff-viewer" id="diffViewer">No changes to review.</div>
        </div>

        <!-- Embedded App Preview -->
        <div class="card" id="previewCard" style="display: none;">
          <div class="section-title">Visual App Canvas</div>
          <iframe id="appIframe" class="app-preview-frame" src="about:blank"></iframe>
        </div>
      </div>
    </main>
  </div>

  <script>
    let activeConversationId = "";

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('projectPath').textContent = data.cwd || 'N/A';
        activeConversationId = data.conversationId || '';
        document.getElementById('convId').textContent = activeConversationId ? 'ID: ' + activeConversationId : 'ID: Ready (New Session)';
        if (data.models && data.models.length > 0) {
          const select = document.getElementById('modelSelect');
          select.innerHTML = '';
          data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label;
            if (m.id === data.activeModel) opt.selected = true;
            select.appendChild(opt);
          });
        }
        checkDiff();
      } catch (e) {
        console.error(e);
      }
    }

    async function sendPrompt() {
      const prompt = document.getElementById('promptInput').value.trim();
      if (!prompt) return;

      const model = document.getElementById('modelSelect').value;
      const sendBtn = document.getElementById('sendBtn');
      const spinner = document.getElementById('taskSpinner');
      const feed = document.getElementById('streamFeed');

      sendBtn.disabled = true;
      spinner.style.display = 'inline';
      feed.textContent = '[Antigravity] Starting execution...\\n';

      try {
        const res = await fetch('/api/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, model, conversationId: activeConversationId })
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.type === 'progress') {
                feed.textContent += data.message;
                feed.scrollTop = feed.scrollHeight;
              } else if (data.type === 'tool_start') {
                feed.textContent += '\\n[Tool] ' + data.name + (data.detail ? ': ' + data.detail : '') + '\\n';
                feed.scrollTop = feed.scrollHeight;
              } else if (data.type === 'tool_done') {
                feed.textContent += '[Tool] ' + data.name + ' completed ✓\\n';
                feed.scrollTop = feed.scrollHeight;
              } else if (data.type === 'session_init') {
                activeConversationId = data.conversationId;
                document.getElementById('convId').textContent = 'ID: ' + activeConversationId;
              } else if (data.type === 'result') {
                feed.textContent += '\\n\\n=== Finished ===\\n' + (data.response || 'Success') + '\\n';
                feed.scrollTop = feed.scrollHeight;
              } else if (data.type === 'error') {
                feed.textContent += '\\n[Error] ' + data.message + '\\n';
              }
            } catch (_) {}
          }
        }
      } catch (err) {
        feed.textContent += '\\n[Request Error] ' + err.message;
      } finally {
        sendBtn.disabled = false;
        spinner.style.display = 'none';
        checkDiff();
      }
    }

    async function checkDiff() {
      try {
        const res = await fetch('/api/diff');
        const data = await res.json();
        const diffCard = document.getElementById('diffCard');
        const diffViewer = document.getElementById('diffViewer');

        if (data.hasChanges && data.diff) {
          diffCard.style.display = 'block';
          diffViewer.textContent = data.diff;
        } else {
          diffCard.style.display = 'none';
        }
      } catch (_) {}
    }

    async function acceptChanges() {
      if (!confirm('Accept and commit these changes?')) return;
      await fetch('/api/accept', { method: 'POST' });
      checkDiff();
      alert('Changes accepted and committed!');
    }

    async function rejectChanges() {
      if (!confirm('Are you sure you want to revert all changes?')) return;
      await fetch('/api/reject', { method: 'POST' });
      checkDiff();
      alert('Changes reverted to original state.');
    }

    async function resetSession() {
      if (!confirm('Start a new session? This clears context memory.')) return;
      await fetch('/api/reset-session', { method: 'POST' });
      activeConversationId = '';
      document.getElementById('convId').textContent = 'ID: Ready (New Session)';
      document.getElementById('streamFeed').textContent = 'Session reset. Context memory cleared.';
    }

    function loadPreview() {
      const url = document.getElementById('previewUrl').value.trim();
      if (!url) return;
      document.getElementById('previewCard').style.display = 'block';
      document.getElementById('appIframe').src = url;
    }

    loadStatus();
  </script>
</body>
</html>`;
}

// Request handler
function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url ? req.url.split("?")[0] : "/";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Serve UI
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderHtml());
      return;
    }

    // Status API
    if (url === "/api/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "running",
        cwd: activeProjectDir,
        conversationId: activeConversationId,
        activeModel,
        models: getAvailableModels(),
      }));
      return;
    }

    // Reset Session
    if (url === "/api/reset-session" && req.method === "POST") {
      saveConversationId("");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, conversationId: "" }));
      return;
    }

    // Git Diff
    if (url === "/api/diff" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getGitStatus(activeProjectDir)));
      return;
    }

    // Accept Changes
    if (url === "/api/accept" && req.method === "POST") {
      try {
        execSync('git add -A && git commit -m "Applied changes via Lasso Agent"', { cwd: activeProjectDir });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Reject Changes
    if (url === "/api/reject" && req.method === "POST") {
      try {
        execSync("git checkout -- . && git clean -fd", { cwd: activeProjectDir });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Prompt Execution via Antigravity
    if (url === "/api/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(body); } catch (_) {}

        const prompt = payload.prompt || "";
        const model = payload.model || activeModel;
        const convId = payload.conversationId || activeConversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || "";

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Prompt is required" }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache",
        });

        // Launch agy
        const args = [
          "-p", prompt,
          "--output-format", "stream-json",
          "--mode", "accept-edits",
          "--dangerously-skip-permissions"
        ];
        if (model) args.push("--model", model);
        if (convId) args.push("--conversation", convId);

        const child = spawn("agy", args, {
          cwd: activeProjectDir,
          env: { ...process.env, LASSO_ORCHESTRATOR: "1" }
        });

        let stdoutBuffer = "";

        child.stdout.on("data", chunk => {
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

              if (event.event === "init") {
                res.write(JSON.stringify({ type: "session_init", conversationId: event.conversation_id }) + "\n");
              } else if (event.event === "step_update") {
                const step = event.step_update;
                if (step?.step_type === "agent_response" && step.text_delta) {
                  res.write(JSON.stringify({ type: "progress", message: step.text_delta }) + "\n");
                } else if (step?.step_type === "tool") {
                  if (step.state === "ACTIVE") {
                    res.write(JSON.stringify({
                      type: "tool_start",
                      name: step.tool_name || "tool",
                      detail: step.tool_info?.parameters?.CommandLine || step.tool_info?.parameters?.TargetFile || ""
                    }) + "\n");
                  } else if (step.state === "DONE") {
                    res.write(JSON.stringify({ type: "tool_done", name: step.tool_name || "tool" }) + "\n");
                  }
                }
              } else if (event.event === "result") {
                const r = event.result;
                if (r?.conversation_id) saveConversationId(r.conversation_id);
                res.write(JSON.stringify({
                  type: "result",
                  status: r?.status,
                  response: r?.response
                }) + "\n");
              }
            } catch (_) {}
          }
        });

        child.stderr.on("data", chunk => {
          const text = chunk.toString("utf8");
          if (text.includes("error") || text.includes("Error")) {
            res.write(JSON.stringify({ type: "error", message: text.slice(0, 300) }) + "\n");
          }
        });

        child.on("close", code => {
          if (stdoutBuffer.trim().startsWith("{")) {
            try {
              const event = JSON.parse(stdoutBuffer.trim());
              if (event.event === "result") {
                res.write(JSON.stringify({ type: "result", status: event.result?.status, response: event.result?.response }) + "\n");
              }
            } catch (_) {}
          }
          res.end();
        });

        child.on("error", err => {
          res.write(JSON.stringify({ type: "error", message: "Failed to spawn agy: " + err.message }) + "\n");
          res.end();
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
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
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: actualPort, startTime: Date.now() }));
    console.log(`[Lasso Agent] Running on http://127.0.0.1:${actualPort}`);
    console.log(`[Lasso Agent] Project directory: ${activeProjectDir}`);
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
