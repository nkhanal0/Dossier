/**
 * Claude Bridge — Uses voice-agents daemon for persistent Claude sessions.
 *
 * The voice-agents daemon (Go binary at port 8787) keeps a Claude interactive
 * session alive via PTY. We send messages and read responses through its HTTP API.
 *
 * API:
 *   POST /v1/start  {cwd, cmd}     → {id, ok}
 *   POST /v1/send   {id, text}     → {ok}
 *   GET  /v1/tail    ?id=&n=&strip= → {id, lines[], ok}
 *   GET  /v1/sessions               → {sessions[], ok}
 */

const DAEMON_URL = process.env.CLAUDE_DAEMON_URL || 'http://127.0.0.1:8787';

/**
 * Extract clean response text from raw PTY output.
 * PTY output contains: cursor movements, ⏺ markers, ❯ prompts, ──── dividers, etc.
 */
function extractResponseFromPTY(raw: string): string {
  return raw
    // Remove everything before the first ⏺ (that's where Claude's response starts)
    .replace(/^[\s\S]*?⏺\s*/, '')
    // Remove file markers like "1 file (ctrl+o to expand)"
    .replace(/\d+ files? \(ctrl\+o to expand\)/g, '')
    // Remove ❯ prompts and everything after
    .replace(/❯[\s\S]*$/g, '')
    // Remove ──── dividers
    .replace(/────+/g, '')
    // Remove "esc to interrupt" markers
    .replace(/esc to interrupt/g, '')
    // Remove ? for shortcuts
    .replace(/\? for shortcuts/g, '')
    // Remove ⏺ markers
    .replace(/⏺/g, '')
    // Remove ✶ and ✳ spinners
    .replace(/[✶✳]/g, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Trim
    .trim();
}

let sessionId: string | null = null;
let sessionReady = false;

interface DaemonResponse {
  ok: boolean;
  id?: string;
  lines?: string[];
  sessions?: Array<{ id: string; running: boolean }>;
  error?: string;
}

async function daemonFetch(path: string, options?: RequestInit): Promise<DaemonResponse> {
  const res = await fetch(`${DAEMON_URL}${path}`, options);
  return res.json() as Promise<DaemonResponse>;
}

/**
 * Ensure a Claude session is running in the daemon.
 */
async function ensureSession(): Promise<string> {
  if (sessionId) {
    // Check if still alive
    try {
      const resp = await daemonFetch('/v1/sessions');
      const alive = resp.sessions?.find(s => s.id === sessionId && s.running);
      if (alive) return sessionId;
    } catch { /* daemon might be down */ }
  }

  // Start new session
  const model = process.env.CLAUDE_CLI_MODEL || 'haiku';
  const resp = await daemonFetch('/v1/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: '/tmp',
      cmd: ['claude', '--model', model],
    }),
  });

  if (!resp.ok || !resp.id) {
    throw new Error('Failed to start Claude session in daemon');
  }

  sessionId = resp.id;
  sessionReady = false;

  // Wait for Claude to initialize (trust prompt + startup)
  await waitForReady(sessionId, 30000);

  return sessionId;
}

/**
 * Wait for Claude to be ready for input (past the trust prompt).
 */
async function waitForReady(id: string, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000));
    const resp = await daemonFetch(`/v1/tail?id=${id}&n=5&strip=1`);
    const lines = resp.lines || [];
    const text = lines.join(' ');

    // If we see the trust prompt, send Enter
    if (text.includes('trust') && text.includes('Enter to confirm')) {
      await daemonFetch('/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text: '\r' }),
      });
      continue;
    }

    // If we see the input prompt (❯), it's ready
    if (text.includes('❯') && !text.includes('trust')) {
      sessionReady = true;
      return;
    }
  }

  // If we timed out but session exists, try anyway
  sessionReady = true;
}

/**
 * Send a message to Claude via the daemon and wait for response.
 */
export async function claudeBridgeRequest(
  systemPrompt: string,
  userMessage: string,
  options?: { model?: string; timeoutMs?: number }
): Promise<{ text: string; durationMs: number; model: string; sessionId: string }> {
  const timeoutMs = options?.timeoutMs || 120000;
  const id = await ensureSession();

  // Get current tail position (so we know where new output starts)
  const beforeResp = await daemonFetch(`/v1/tail?id=${id}&n=200&strip=1`);
  const beforeLines = beforeResp.lines?.length || 0;

  // Send the message (system prompt + user message combined)
  const fullMessage = systemPrompt
    ? `Given this context: ${systemPrompt.slice(0, 2000)}\n\nUser request: ${userMessage}`
    : userMessage;

  await daemonFetch('/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, text: fullMessage + '\r' }),
  });

  // Poll for response — watch for the ❯ prompt to reappear (means Claude is done)
  const start = Date.now();
  let responseText = '';
  let prevTailText = (beforeResp.lines || []).join('\n');

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));

    const resp = await daemonFetch(`/v1/tail?id=${id}&n=100&strip=1`);
    const lines = resp.lines || [];
    const currentText = lines.join('\n');

    // New output appeared since we sent the message
    if (currentText.length > prevTailText.length) {
      const newOutput = currentText.slice(prevTailText.length);

      // Check if Claude is done — look for the ❯ prompt after response content
      // The pattern is: response text, then ────, then ❯
      const hasPrompt = newOutput.includes('❯') &&
        (newOutput.lastIndexOf('❯') > newOutput.lastIndexOf('⏺'));

      if (hasPrompt) {
        // Extract the response text between ⏺ markers and ❯ prompt
        responseText = extractResponseFromPTY(newOutput);
        break;
      }
    }
  }

  return {
    text: responseText || '(No response captured)',
    durationMs: Date.now() - start,
    model: options?.model || 'haiku',
    sessionId: id,
  };
}

/**
 * Stream version — polls and yields new text as it appears.
 */
export function claudeBridgeStream(
  systemPrompt: string,
  userMessage: string,
  options?: { model?: string; timeoutMs?: number }
): ReadableStream<string> {
  const timeoutMs = options?.timeoutMs || 120000;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const result = await claudeBridgeRequest(systemPrompt, userMessage, options);
        controller.enqueue(result.text);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Check if the daemon is running.
 */
export async function checkClaudeCli(): Promise<boolean> {
  try {
    const resp = await daemonFetch('/v1/sessions');
    return resp.ok === true;
  } catch {
    return false;
  }
}
