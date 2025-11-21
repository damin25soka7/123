const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ========================================
// 설정
// ========================================
const PORT = 3000;
const HOST = '127.0.0.1';
const CONFIG_FILE = path.join(__dirname, 'mcp-config.json');

// ========================================
// 로그 시스템
// ========================================
const logs = [];
const MAX_LOGS = 1000;
const logClients = new Set();

function addLog(type, message, mcpName = null) {
  const log = {
    timestamp: new Date().toISOString(),
    type, // 'info', 'error', 'mcp', 'session'
    message,
    mcpName
  };
  logs.push(log);
  if (logs.length > MAX_LOGS) logs.shift();

  // Broadcast to all SSE clients
  const logJson = JSON.stringify(log);
  for (const client of logClients) {
    try {
      client.write(`data: ${logJson}\n\n`);
    } catch (e) {
      logClients.delete(client);
    }
  }
}

// Override console.log
const originalLog = console.log;
console.log = function(...args) {
  const message = args.join(' ');

  // Parse MCP messages
  if (message.startsWith('[')) {
    const match = message.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      const [, mcpName, msg] = match;
      addLog('mcp', msg, mcpName);
    } else {
      addLog('info', message);
    }
  } else {
    addLog('info', message);
  }

  originalLog.apply(console, args);
};

const sessions = new Map();

function generateId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return Date.now().toString() + Math.random().toString(36).substring(7);
  }
}

const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SESSION_NOT_FOUND: -32001,
  SERVER_ERROR: -32000
};

function createErrorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id || null,
    error: { code, message }
  };
}

// JSON 설정 로드
function loadConfig() {
  try {
    const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(configData);
    return config.mcpServers || {};
  } catch (e) {
    console.error('❌ Failed to load config:', e.message);
    console.error(`   Check: ${CONFIG_FILE}`);
    process.exit(1);
  }
}

// MCP 프로세스 관리
class MCPProcess {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.buffer = '';
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.tools = [];
    this.initialized = false;

    const envVars = {
      ...process.env,
      ...(config.env || {})
    };

    const isWindows = process.platform === 'win32';
    let command = config.command;
    let args = config.args || [];

    if (isWindows) {
      if (command === 'npx') {
        command = 'npx.cmd';
      } else if (command === 'uvx') {
        command = 'uvx.exe';
      } else if (command === 'uv') {
        command = 'uv.exe';
      }
    }

    console.log(`[${name}] Starting: ${command} ${args.join(' ')}`);

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envVars,
      shell: isWindows
    });

    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && trimmedLine.startsWith('{')) {
          try {
            const jsonData = JSON.parse(trimmedLine);
            this.handleMCPResponse(jsonData);
          } catch (e) {}
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      const text = data.toString();
      if (!text.includes('npm') && !text.includes('Downloading')) {
        console.log(`[${name}] ${text.trim()}`);
      }
    });

    this.process.on('close', (code) => {
      console.log(`[${name}] Process exited with code ${code}`);
    });

    this.process.on('error', (err) => {
      console.error(`[${name}] Process error:`, err);
    });
  }

  handleMCPResponse(data) {
    if (data.id && this.pendingRequests.has(data.id)) {
      const resolver = this.pendingRequests.get(data.id);
      this.pendingRequests.delete(data.id);
      resolver(data);
    }
  }

  async sendRequest(method, params = null) {
    const id = (++this.requestId).toString();
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== null && { params })
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, resolve);
      this.process.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 90000);
    });
  }

  sendNotification(method, params = null) {
    const notification = {
      jsonrpc: '2.0',
      method,
      ...(params !== null && { params })
    };
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  async initialize() {
    console.log(`[${this.name}] Initializing...`);

    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'RisuAI-MCP-Wrapper',
        version: '1.0.0'
      }
    });

    if (response.result) {
      console.log(`[${this.name}] ✅ ${response.result.serverInfo?.name || 'initialized'}`);
      this.sendNotification('notifications/initialized');

      const toolsResponse = await this.sendRequest('tools/list');
      if (toolsResponse.result && toolsResponse.result.tools) {
        this.tools = toolsResponse.result.tools;
        console.log(`[${this.name}] 🔧 ${this.tools.length} tools`);
      }

      this.initialized = true;
    }
  }

  async callTool(name, args) {
    return await this.sendRequest('tools/call', {
      name,
      arguments: args
    });
  }

  destroy() {
    try {
      this.process.kill();
    } catch (e) {}
  }
}

// 멀티 MCP 세션
class MultiMCPSession {
  constructor(mcpConfigs) {
    this.id = generateId();
    this.clients = new Set();
    this.mcpProcesses = new Map();
    this.mcpConfigs = mcpConfigs;
    this.allTools = [];
    this.cleanupTimer = null;
  }

  async initialize() {
    const enabledServers = Object.entries(this.mcpConfigs)
      .filter(([_, config]) => !config.disabled);

    if (enabledServers.length === 0) {
      throw new Error('No MCP servers enabled');
    }

    for (const [name, config] of enabledServers) {
      const mcpProcess = new MCPProcess(name, config);
      this.mcpProcesses.set(name, mcpProcess);
    }

    const initPromises = Array.from(this.mcpProcesses.values())
      .map(mcp => mcp.initialize());

    await Promise.all(initPromises);
    this.collectAllTools();

    console.log(`[Session ${this.id}] ✅ ${this.mcpProcesses.size} MCPs initialized`);
  }

  collectAllTools() {
    this.allTools = [];
    for (const [mcpName, mcpProcess] of this.mcpProcesses) {
      for (const tool of mcpProcess.tools) {
        this.allTools.push({
          ...tool,
          name: tool.name,
          _mcp: mcpName
        });
      }
    }
    console.log(`[Session ${this.id}] 📦 ${this.allTools.length} total tools`);
  }

  async callTool(toolName, args) {
    const tool = this.allTools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }

    const mcpName = tool._mcp;
    const mcpProcess = this.mcpProcesses.get(mcpName);
    if (!mcpProcess) {
      throw new Error(`MCP '${mcpName}' not found`);
    }

    console.log(`[Session ${this.id}] 🔧 ${toolName} → ${mcpName}`);
    return await mcpProcess.callTool(toolName, args);
  }

  addClient(response) {
    this.clients.add(response);
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  removeClient(response) {
    this.clients.delete(response);
    if (this.clients.size === 0) {
      this.cleanupTimer = setTimeout(() => {
        this.destroy();
      }, 5 * 60 * 1000);
    }
  }

  destroy() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
    }
    for (const [name, mcpProcess] of this.mcpProcesses) {
      mcpProcess.destroy();
    }
    sessions.delete(this.id);
  }
}

// HTTP 서버
const mcpConfigs = loadConfig();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`${req.method} ${req.url}`);

  // GET / - Hover Effect + Compact List
  if (req.method === 'GET' && req.url === '/') {
    const enabledServers = Object.entries(mcpConfigs)
      .filter(([_, config]) => !config.disabled);
    
    const disabledServers = Object.entries(mcpConfigs)
      .filter(([_, config]) => config.disabled);

    const enabledServersList = enabledServers.map(([name, config]) => {
      const cmd = `${config.command} ${(config.args || []).slice(0, 2).join(' ')}${config.args?.length > 2 ? '...' : ''}`;
      return `
        <div class="server-item active">
          <div class="server-indicator">
            <div class="server-pulse"></div>
            <div class="server-dot"></div>
          </div>
          <div class="server-info">
            <div class="server-name">${name}</div>
            <div class="server-cmd">${cmd}</div>
          </div>
          <div class="server-badge active-badge">●</div>
        </div>
      `;
    }).join('');

    const disabledServersList = disabledServers.map(([name, config]) => {
      const cmd = `${config.command} ${(config.args || []).slice(0, 2).join(' ')}${config.args?.length > 2 ? '...' : ''}`;
      return `
        <div class="server-item disabled">
          <div class="server-indicator">
            <div class="server-dot disabled"></div>
          </div>
          <div class="server-info">
            <div class="server-name">${name}</div>
            <div class="server-cmd">${cmd}</div>
          </div>
          <div class="server-badge disabled-badge">○</div>
        </div>
      `;
    }).join('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RisuAI MCP ✨</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;400;500;600;700&family=Fredoka:wght@300;400;500;600;700&family=Quicksand:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --gradient-main: linear-gradient(135deg, #a99ed5 0%, #b8aed8 50%, #d4c9e8 100%);

      --bg: #fafafa;
      --surface: #ffffff;
      --text: #2d2d3d;
      --text-secondary: #5a5a6e;
      --text-tertiary: #9b9bae;
      --border: #e8e8f0;
      --shadow: rgba(102, 126, 234, 0.08);
      --shadow-hover: rgba(102, 126, 234, 0.15);
      --purple: #9b8ac4;
      --purple-light: #b8aed8;
      --purple-lighter: #d4c9e8;
      --purple-pale: #f3f0f9;
      --mint: #a8e6cf;
      --mint-light: #c8f5e0;
      --mint-bg: #f0fdf7;
      --gray: #9b9bae;
      --gray-bg: #f5f5f8;
    }

    [data-theme="dark"] {
      --gradient-main: linear-gradient(135deg, #6b5b95 0%, #7d6ba0 50%, #9b8ac4 100%);

      --bg: #1a1a2e;
      --surface: #252540;
      --text: #e8e8f0;
      --text-secondary: #b8b8c8;
      --text-tertiary: #8888a0;
      --border: #3a3a55;
      --shadow: rgba(0, 0, 0, 0.3);
      --shadow-hover: rgba(155, 138, 196, 0.25);
      --purple: #b8a5d8;
      --purple-light: #9b8ac4;
      --purple-lighter: #7d6ba0;
      --purple-pale: #2d2d45;
      --mint: #7dd3b0;
      --mint-light: #5cb890;
      --mint-bg: #1e3a2f;
      --gray: #8888a0;
      --gray-bg: #2a2a42;
    }

    body {
      font-family: 'Quicksand', 'Comfortaa', sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    .background-shapes {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      z-index: 0;
      pointer-events: none;
    }

    .shape {
      position: absolute;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.4;
      animation: float 25s infinite ease-in-out;
    }

    .shape-1 {
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(155, 138, 196, 0.3), transparent);
      top: -150px;
      left: -100px;
      animation-delay: 0s;
    }

    .shape-2 {
      width: 400px;
      height: 400px;
      background: radial-gradient(circle, rgba(212, 201, 232, 0.4), transparent);
      top: 40%;
      right: -100px;
      animation-delay: 8s;
    }

    .shape-3 {
      width: 450px;
      height: 450px;
      background: radial-gradient(circle, rgba(184, 174, 216, 0.35), transparent);
      bottom: -100px;
      left: 30%;
      animation-delay: 16s;
    }

    @keyframes float {
      0%, 100% {
        transform: translate(0, 0) rotate(0deg);
      }
      33% {
        transform: translate(40px, -40px) rotate(120deg);
      }
      66% {
        transform: translate(-30px, 30px) rotate(240deg);
      }
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 60px 24px;
      position: relative;
      z-index: 1;
    }

    header {
      text-align: center;
      margin-bottom: 60px;
      position: relative;
    }

    .logo-wrapper {
      display: inline-block;
      position: relative;
      margin-bottom: 24px;
    }

    .logo {
      width: 100px;
      height: 100px;
      border-radius: 24px;
      background: linear-gradient(135deg, #a99ed5 0%, #d4c9e8 100%);
      box-shadow: 
        0 20px 60px rgba(155, 138, 196, 0.3),
        0 0 80px rgba(212, 201, 232, 0.2);
      animation: logoFloat 6s ease-in-out infinite;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s ease;
    }

    .logo:hover {
      transform: scale(1.05);
    }

    .logo-icon {
      width: 60px;
      height: 40px;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 18px;
    }

    .eye {
      width: 18px;
      height: 18px;
      background: rgba(255, 255, 255, 0.9);
      border-radius: 50%;
      position: relative;
      overflow: visible;
      transition: all 0.3s ease;
    }

    .pupil {
      width: 10px;
      height: 10px;
      background: var(--purple);
      border-radius: 50%;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      transition: all 0.15s ease;
      box-shadow: 0 0 6px rgba(155, 138, 196, 0.4);
    }

    /* Hover effect - >-< face */
    .logo:hover .eye {
      width: 20px;
      height: 3px;
      border-radius: 2px;
    }

    .logo:hover .eye:nth-child(1) {
      transform: rotate(-20deg);  /* 왼쪽 눈 > */
    }

    .logo:hover .eye:nth-child(2) {
      transform: rotate(20deg);  /* 오른쪽 눈 < */
    }

    .logo:hover .pupil {
      opacity: 0;
      visibility: hidden;  /* 완전히 숨기기 */
    }

    .logo:hover .mouth {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      bottom: 6px;
    }
    .eye.blink {
      animation: blink 4s infinite;
    }

    @keyframes blink {
      0%, 100% {
        transform: scaleY(1);
        height: 18px;
      }
      46%, 54% {
        transform: scaleY(1);
        height: 18px;
      }
      48%, 50%, 52% {
        transform: scaleY(0.05);
        height: 2px;
      }
    }

    .logo:hover .eye.blink {
      animation: none;
    }

    .mouth {
      position: absolute;
      width: 24px;
      height: 3px;
      background: rgba(255, 255, 255, 0.85);
      border-radius: 2px;
      bottom: 8px;
      left: 50%;
      transform: translateX(-50%);
      transition: all 0.3s ease;
    }

    @keyframes logoFloat {
      0%, 100% {
        transform: translateY(0) rotate(0deg);
      }
      50% {
        transform: translateY(-10px) rotate(5deg);
      }
    }

    h1 {
      font-family: 'Fredoka', 'Comfortaa', sans-serif;
      font-size: 3.5rem;
      font-weight: 700;
      background: var(--gradient-main);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 16px;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }

    .subtitle {
      font-family: 'Comfortaa', sans-serif;
      font-size: 1.125rem;
      color: var(--text-secondary);
      font-weight: 400;
      letter-spacing: 0.03em;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 20px;
      background: var(--mint-bg);
      border: 2px solid var(--mint);
      border-radius: 100px;
      font-size: 0.875rem;
      font-weight: 600;
      color: #2d8a4e;
      margin-top: 20px;
      font-family: 'Comfortaa', sans-serif;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      background: var(--mint);
      border-radius: 50%;
      box-shadow: 0 0 12px var(--mint);
      animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.6;
        transform: scale(0.85);
      }
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }

    .stat-card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 24px;
      padding: 32px;
      position: relative;
      overflow: hidden;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 20px var(--shadow);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--purple-light), var(--purple-lighter));
      opacity: 0;
      transition: opacity 0.4s ease;
    }

    .stat-card:hover {
      transform: translateY(-8px);
      border-color: var(--purple-light);
      box-shadow: 0 20px 60px var(--shadow-hover);
    }

    .stat-card:hover::before {
      opacity: 1;
    }

    .stat-icon {
      font-size: 2.5rem;
      margin-bottom: 16px;
      display: block;
    }

    .stat-label {
      font-family: 'Comfortaa', sans-serif;
      font-size: 0.875rem;
      color: var(--text-tertiary);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 8px;
    }

    .stat-value {
      font-family: 'Fredoka', sans-serif;
      font-size: 3rem;
      font-weight: 700;
      color: var(--purple);
      line-height: 1;
    }

    .glass-card {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 28px;
      padding: 40px;
      margin-bottom: 32px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 20px var(--shadow);
    }

    .glass-card::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle, rgba(212, 201, 232, 0.15) 0%, transparent 70%);
      animation: rotate 20s linear infinite;
      pointer-events: none;
    }

    @keyframes rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .card-title {
      font-family: 'Fredoka', sans-serif;
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 24px;
      position: relative;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--text);
    }

    .endpoint-showcase {
      background: linear-gradient(135deg, var(--purple-pale) 0%, rgba(212, 201, 232, 0.3) 100%);
      padding: 32px;
      border-radius: 20px;
      text-align: center;
      position: relative;
      z-index: 1;
      border: 2px solid var(--purple-lighter);
    }

    .endpoint-label {
      font-family: 'Comfortaa', sans-serif;
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--purple);
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 16px;
    }

    .endpoint-url {
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text);
      background: var(--surface);
      padding: 16px 28px;
      border-radius: 12px;
      display: inline-block;
      cursor: pointer;
      user-select: all;
      border: 2px solid var(--border);
      transition: all 0.3s ease;
      box-shadow: 0 2px 12px var(--shadow);
    }

    .endpoint-url:hover {
      border-color: var(--purple-light);
      box-shadow: 0 8px 32px var(--shadow-hover);
      transform: scale(1.02);
    }

    .endpoint-hint {
      font-family: 'Comfortaa', sans-serif;
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-top: 16px;
    }

    .servers-container {
      position: relative;
      z-index: 1;
    }

    .servers-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .server-item {
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 14px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 14px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 2px 8px var(--shadow);
      position: relative;
      overflow: hidden;
    }

    .server-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--mint);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .server-item.active::before {
      opacity: 1;
    }

    .server-item.active {
      border-color: var(--mint);
      background: linear-gradient(135deg, var(--mint-bg) 0%, var(--surface) 100%);
    }

    .server-item.disabled {
      opacity: 0.6;
      border-color: var(--border);
    }

    .server-item:hover {
      transform: translateX(6px);
      box-shadow: 0 6px 24px var(--shadow-hover);
    }

    .server-item.active:hover {
      box-shadow: 0 6px 24px rgba(168, 230, 207, 0.25);
    }

    .server-indicator {
      position: relative;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .server-pulse {
      position: absolute;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--mint);
      opacity: 0.3;
      animation: pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    @keyframes pulse-ring {
      0% {
        transform: scale(0.8);
        opacity: 0.3;
      }
      50% {
        transform: scale(1);
        opacity: 0.1;
      }
      100% {
        transform: scale(0.8);
        opacity: 0.3;
      }
    }

    .server-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--mint);
      box-shadow: 0 0 16px var(--mint), 0 3px 8px rgba(168, 230, 207, 0.4);
      position: relative;
      z-index: 1;
    }

    .server-dot.disabled {
      background: var(--gray);
      box-shadow: none;
    }

    .server-info {
      flex: 1;
      min-width: 0;
    }

    .server-name {
      font-family: 'Fredoka', sans-serif;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
    }

    .server-cmd {
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 0.75rem;
      color: var(--text-tertiary);
      background: rgba(0, 0, 0, 0.03);
      padding: 4px 8px;
      border-radius: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .server-badge {
      padding: 4px 10px;
      border-radius: 100px;
      font-family: 'Comfortaa', sans-serif;
      font-size: 0.75rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .active-badge {
      background: var(--mint-bg);
      color: #2d8a4e;
      border: 2px solid var(--mint);
    }

    .disabled-badge {
      background: var(--gray-bg);
      color: var(--gray);
      border: 2px solid #d8d8e0;
    }

    .section-divider {
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--border), transparent);
      margin: 32px 0;
      position: relative;
    }

    .section-divider::before {
      content: '⚡';
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      background: var(--surface);
      padding: 0 12px;
      font-size: 1rem;
    }

    .log-controls {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      position: relative;
      z-index: 1;
    }

    .btn {
      padding: 12px 24px;
      background: var(--surface);
      color: var(--text);
      border: 2px solid var(--border);
      border-radius: 12px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      font-family: 'Comfortaa', sans-serif;
      box-shadow: 0 2px 8px var(--shadow);
    }

    .btn:hover {
      border-color: var(--purple-light);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px var(--shadow-hover);
      background: var(--purple-pale);
    }

    #log-container {
      background: var(--surface);
      border-radius: 16px;
      padding: 20px;
      height: 450px;
      overflow-y: auto;
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 0.813rem;
      border: 2px solid var(--border);
      position: relative;
      z-index: 1;
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.04);
    }

    .log-entry {
      padding: 10px 12px;
      margin-bottom: 4px;
      border-radius: 8px;
      border-left: 3px solid transparent;
      transition: all 0.2s ease;
      animation: slideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(-16px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .log-entry:hover {
      background: var(--purple-pale);
      border-left-color: var(--purple-light);
    }

    .log-time {
      color: var(--text-tertiary);
      margin-right: 12px;
    }

    .log-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 6px;
      font-size: 0.688rem;
      font-weight: 700;
      margin-right: 10px;
      text-transform: uppercase;
      font-family: 'Comfortaa', sans-serif;
    }

    .log-badge.info {
      background: rgba(79, 195, 247, 0.15);
      color: #1976d2;
    }

    .log-badge.error {
      background: rgba(255, 107, 107, 0.15);
      color: #d32f2f;
    }

    .log-badge.mcp {
      background: rgba(155, 138, 196, 0.15);
      color: var(--purple);
    }

    .log-badge.session {
      background: rgba(255, 184, 77, 0.15);
      color: #f57c00;
    }

    .log-mcp {
      color: var(--purple);
      font-weight: 700;
      margin-right: 10px;
    }

    .log-text {
      color: var(--text-secondary);
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-tertiary);
      font-family: 'Comfortaa', sans-serif;
    }

    .empty-icon {
      font-size: 4rem;
      margin-bottom: 16px;
      opacity: 0.3;
    }

    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    ::-webkit-scrollbar-track {
      background: var(--purple-pale);
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb {
      background: linear-gradient(135deg, var(--purple-light), var(--purple));
      border-radius: 4px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(135deg, var(--purple), var(--purple-light));
    }

    /* Dark Mode Toggle */
    .theme-toggle {
      position: fixed;
      top: 24px;
      right: 24px;
      z-index: 1000;
      background: var(--surface);
      border: 2px solid var(--border);
      border-radius: 50px;
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      transition: all 0.3s ease;
      box-shadow: 0 4px 20px var(--shadow);
    }

    .theme-toggle:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 25px var(--shadow-hover);
      border-color: var(--purple-light);
    }

    .theme-toggle .icon {
      font-size: 18px;
      transition: transform 0.3s ease;
    }

    .theme-toggle:hover .icon {
      transform: rotate(20deg);
    }

    [data-theme="dark"] .theme-toggle {
      background: var(--surface);
      border-color: var(--purple-light);
    }

    @media (max-width: 768px) {
      .container {
        padding: 40px 16px;
      }

      h1 {
        font-size: 2.5rem;
      }

      .stats {
        grid-template-columns: repeat(2, 1fr);
        gap: 16px;
      }

      .glass-card {
        padding: 24px;
      }

      .server-item {
        flex-wrap: wrap;
      }

      .server-badge {
        width: 100%;
        justify-content: center;
      }

      #log-container {
        height: 350px;
      }
    }
  </style>
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" id="theme-toggle">
    <span class="icon" id="theme-icon">🌙</span>
    <span id="theme-text">Dark</span>
  </button>

  <div class="background-shapes">
    <div class="shape shape-1"></div>
    <div class="shape shape-2"></div>
    <div class="shape shape-3"></div>
  </div>

  <div class="container">
    <header>
      <div class="logo-wrapper">
        <div class="logo">
          <div class="logo-icon">
            <div class="eye blink">
              <div class="pupil" id="pupil-left"></div>
            </div>
            <div class="eye blink" style="animation-delay: 0.05s;">
              <div class="pupil" id="pupil-right"></div>
            </div>
            <div class="mouth"></div>
          </div>
        </div>
      </div>
      <h1>RisuAI MCP ✨</h1>
      <div class="subtitle">Model Context Protocol Gateway</div>
      <div class="status-badge">
        <div class="status-dot"></div>
        Running
      </div>
    </header>

    <div class="stats">
      <div class="stat-card">
        <span class="stat-icon">🔗</span>
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${sessions.size}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">⚡</span>
        <div class="stat-label">Enabled</div>
        <div class="stat-value">${enabledServers.length}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">🛠️</span>
        <div class="stat-label">Tools</div>
        <div class="stat-value" id="total-tools">-</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">🌐</span>
        <div class="stat-label">Port</div>
        <div class="stat-value">${PORT}</div>
      </div>
    </div>

    <div class="glass-card">
      <div class="card-title">🔌 Connection Endpoint</div>
      <div class="endpoint-showcase">
        <div class="endpoint-label">RisuAI Connection URL</div>
        <div class="endpoint-url" onclick="copyText(this.textContent)">http://localhost:${PORT}/sse</div>
        <div class="endpoint-hint">✨ Click to copy</div>
      </div>
    </div>

    <div class="glass-card">
      <div class="card-title">⚡ MCP Servers</div>
      <div class="servers-container">
        <div class="servers-list">
          ${enabledServersList || '<div class="empty-state"><div class="empty-icon">📦</div><div>No active servers</div></div>'}
        </div>
        
        ${disabledServers.length > 0 ? `
          <div class="section-divider"></div>
          <div class="servers-list">
            ${disabledServersList}
          </div>
        ` : ''}
      </div>
    </div>

    <div class="glass-card">
      <div class="card-title">📊 Real-time Logs</div>
      <div class="log-controls">
        <button class="btn" onclick="clearLogs()">Clear Logs</button>
        <button class="btn" onclick="toggleScroll()" id="scroll-btn">Auto-scroll: ON</button>
      </div>
      <div id="log-container"></div>
    </div>
  </div>

  <script>
    // Dark Mode Toggle
    function initTheme() {
      const savedTheme = localStorage.getItem('mcp-theme') || 'light';
      document.documentElement.setAttribute('data-theme', savedTheme);
      updateThemeButton(savedTheme);
    }

    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('mcp-theme', newTheme);
      updateThemeButton(newTheme);
    }

    function updateThemeButton(theme) {
      const icon = document.getElementById('theme-icon');
      const text = document.getElementById('theme-text');
      if (theme === 'dark') {
        icon.textContent = '☀️';
        text.textContent = 'Light';
      } else {
        icon.textContent = '🌙';
        text.textContent = 'Dark';
      }
    }

    initTheme();

    let autoScroll = true;
    const logBox = document.getElementById('log-container');
    const scrollBtn = document.getElementById('scroll-btn');

    function copyText(text) {
      navigator.clipboard.writeText(text);
    }

    function clearLogs() {
      logBox.innerHTML = '';
    }

    function toggleScroll() {
      autoScroll = !autoScroll;
      scrollBtn.textContent = autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
    }

    function addLog(log) {
      const entry = document.createElement('div');
      entry.className = 'log-entry';

      const time = new Date(log.timestamp).toLocaleTimeString('ko-KR');
      let html = \`<span class="log-time">\${time}</span>\`;
      html += \`<span class="log-badge \${log.type}">\${log.type}</span>\`;
      
      if (log.mcpName) {
        html += \`<span class="log-mcp">[\${log.mcpName}]</span>\`;
      }

      html += \`<span class="log-text">\${escapeHTML(log.message)}</span>\`;
      entry.innerHTML = html;

      logBox.appendChild(entry);

      while (logBox.children.length > 300) {
        logBox.removeChild(logBox.firstChild);
      }

      if (autoScroll) {
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    function escapeHTML(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // 눈동자가 마우스를 따라가는 효과
    const logo = document.querySelector('.logo');
    const pupils = document.querySelectorAll('.pupil');

    document.addEventListener('mousemove', (e) => {
      if (logo.matches(':hover')) return;
      
      const logoRect = logo.getBoundingClientRect();
      const logoCenterX = logoRect.left + logoRect.width / 2;
      const logoCenterY = logoRect.top + logoRect.height / 2;
      
      const angle = Math.atan2(e.clientY - logoCenterY, e.clientX - logoCenterX);
      const distance = Math.min(3, Math.hypot(e.clientX - logoCenterX, e.clientY - logoCenterY) / 80);
      
      const pupilX = Math.cos(angle) * distance;
      const pupilY = Math.sin(angle) * distance;
      
      pupils.forEach(pupil => {
        pupil.style.transform = \`translate(calc(-50% + \${pupilX}px), calc(-50% + \${pupilY}px))\`;
      });
    });

    const events = new EventSource('/logs');
    events.onmessage = (e) => {
      try {
        addLog(JSON.parse(e.data));
      } catch (err) {}
    };
    events.onerror = () => setTimeout(() => location.reload(), 3000);
  </script>
</body>
</html>
    `);
    return;
  }

  // ... (나머지 코드 동일 - /logs, /health, /sse, /session/:id 등)

  // GET /logs - SSE endpoint for real-time logs
  if (req.method === 'GET' && req.url === '/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    logClients.add(res);

    for (const log of logs) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    req.on('close', () => {
      logClients.delete(res);
    });

    return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    const enabledMCPs = Object.entries(mcpConfigs)
      .filter(([_, config]) => !config.disabled)
      .map(([name, _]) => name);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      activeSessions: sessions.size,
      enabledMCPs: enabledMCPs,
      totalMCPs: Object.keys(mcpConfigs).length,
      configFile: CONFIG_FILE
    }));
    return;
  }

  // GET /sse
  if (req.method === 'GET' && req.url === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const session = new MultiMCPSession(mcpConfigs);
    sessions.set(session.id, session);
    session.addClient(res);

    res.write(`event: endpoint\ndata: /session/${session.id}\n\n`);

    session.initialize().catch(e => {
      console.error(`[Session ${session.id}] Init failed:`, e);
    });

    req.on('close', () => {
      session.removeClient(res);
    });

    return;
  }

  // POST /session/:id
  if (req.method === 'POST' && req.url.startsWith('/session/')) {
    const sessionId = req.url.split('/')[2];
    const session = sessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(
        createErrorResponse(null, ErrorCodes.SESSION_NOT_FOUND, 'Session not found')
      ));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const jsonRpc = JSON.parse(body);

        if (jsonRpc.method === 'initialize') {
          while (!session.mcpProcesses.size) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          const response = {
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: {
                name: 'risuai-mcp-wrapper',
                version: '1.0.0'
              }
            }
          };

          for (const client of session.clients) {
            client.write(`data: ${JSON.stringify(response)}\n\n`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (jsonRpc.method === 'notifications/initialized') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (jsonRpc.method === 'tools/list') {
          while (!session.allTools.length && session.mcpProcesses.size) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          const tools = session.allTools.map(({ _mcp, ...tool }) => tool);

          const response = {
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: { tools }
          };

          for (const client of session.clients) {
            client.write(`data: ${JSON.stringify(response)}\n\n`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (jsonRpc.method === 'tools/call') {
          const toolName = jsonRpc.params?.name;
          const args = jsonRpc.params?.arguments || {};

          const toolResponse = await session.callTool(toolName, args);

          const response = {
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: toolResponse.result
          };

          for (const client of session.clients) {
            client.write(`data: ${JSON.stringify(response)}\n\n`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (jsonRpc.method === 'ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: {}
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          createErrorResponse(jsonRpc.id, ErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${jsonRpc.method}`)
        ));

      } catch (e) {
        console.error('Request error:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          createErrorResponse(null, ErrorCodes.PARSE_ERROR, 'Parse error')
        ));
      }
    });

    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  const enabledCount = Object.values(mcpConfigs).filter(c => !c.disabled).length;
  const enabledNames = Object.entries(mcpConfigs)
    .filter(([_, c]) => !c.disabled)
    .map(([name, _]) => name)
    .join(', ');

  console.log('\n' + '='.repeat(60));
  console.log('🎭 RisuAI MCP Wrapper Started');
  console.log('='.repeat(60));
  console.log(`📡 Server:    http://${HOST}:${PORT}`);
  console.log(`📄 Config:    ${CONFIG_FILE}`);
  console.log(`🔧 Enabled:   ${enabledCount} MCPs (${enabledNames || 'None'})`);
  console.log('');
  console.log('💡 RisuAI: http://localhost:' + PORT + '/sse');
  console.log('🌐 Web UI: http://localhost:' + PORT);
  console.log('='.repeat(60) + '\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  sessions.forEach(session => session.destroy());
  server.close();
  process.exit(0);
});