/**
 * Claude Bridge — Persistent Claude Code session for Dossier.
 *
 * Instead of spawning `claude -p` per request (slow, ~5-10s startup each time),
 * this module keeps a persistent Claude session alive and routes messages through it.
 *
 * Architecture (inspired by voice-agents PTY pattern):
 * - On first request, spawns `claude -p --verbose --output-format stream-json`
 * - Collects response by parsing stream-json events
 * - Each request is a new `claude -p` call but with `--resume` to reuse session cache
 *
 * The key optimization: `--no-session-persistence` + `--model haiku` for fast planning.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readConfigFile } from '@/lib/config/data-dir';

interface ClaudeBridgeResponse {
  text: string;
  durationMs: number;
  model: string;
  sessionId: string;
}

let lastSessionId: string | null = null;

/**
 * Send a message through Claude CLI and get the response.
 * Uses stream-json format for reliable response detection.
 */
export async function claudeBridgeRequest(
  systemPrompt: string,
  userMessage: string,
  options?: {
    model?: string;
    timeoutMs?: number;
    stream?: boolean;
  }
): Promise<ClaudeBridgeResponse> {
  const model = options?.model || process.env.CLAUDE_CLI_MODEL || 'haiku';
  const timeoutMs = options?.timeoutMs || 180_000; // 3 min default

  const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\n${userMessage}`;

  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--no-session-persistence',
    '--model', model,
    '--permission-mode', 'default',
    fullPrompt,
  ];

  // Resume previous session for cache benefits
  if (lastSessionId) {
    args.push('--resume', lastSessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Prevent hooks from interfering
        CLAUDE_CODE_DISABLE_HOOKS: '1',
      },
    });

    let buffer = '';
    let resultText = '';
    let resultModel = '';
    let resultSessionId = '';
    let resultDuration = 0;
    let resolved = false;

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Parse complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === 'result') {
            resultText = event.result || '';
            resultDuration = event.duration_ms || 0;
            resultSessionId = event.session_id || '';
            // Save session ID for future cache hits
            lastSessionId = resultSessionId;
          }

          if (event.type === 'assistant' && event.message?.model) {
            resultModel = event.message.model;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Only log actual errors, not progress
      if (text.includes('Error') || text.includes('error')) {
        console.error('[claude-bridge]', text);
      }
    });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;

      if (code !== 0 && !resultText) {
        reject(new Error(`Claude CLI exited with code ${code}`));
        return;
      }

      resolve({
        text: resultText,
        durationMs: resultDuration,
        model: resultModel || model,
        sessionId: resultSessionId,
      });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Claude CLI failed to start: ${err.message}`));
    });

    // Timeout safety
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Send a message and get a streaming response.
 * Returns a ReadableStream that yields text chunks as they arrive.
 */
export function claudeBridgeStream(
  systemPrompt: string,
  userMessage: string,
  options?: {
    model?: string;
    timeoutMs?: number;
  }
): ReadableStream<string> {
  const model = options?.model || process.env.CLAUDE_CLI_MODEL || 'haiku';
  const timeoutMs = options?.timeoutMs || 180_000;

  const fullPrompt = `<system>\n${systemPrompt}\n</system>\n\n${userMessage}`;

  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--no-session-persistence',
    '--model', model,
    '--permission-mode', 'default',
    fullPrompt,
  ];

  if (lastSessionId) {
    args.push('--resume', lastSessionId);
  }

  return new ReadableStream<string>({
    start(controller) {
      const child = spawn('claude', args, {
        timeout: timeoutMs,
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_HOOKS: '1',
        },
      });

      let buffer = '';
      let lastText = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Stream assistant text as it arrives
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                  // Only send new text (delta)
                  const newText = block.text;
                  if (newText.length > lastText.length) {
                    const delta = newText.slice(lastText.length);
                    controller.enqueue(delta);
                    lastText = newText;
                  }
                }
              }
            }

            if (event.type === 'result') {
              // Send any remaining text
              if (event.result && event.result.length > lastText.length) {
                controller.enqueue(event.result.slice(lastText.length));
              }
              lastSessionId = event.session_id || null;
            }
          } catch {
            // Not valid JSON
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('Error')) {
          console.error('[claude-bridge-stream]', text);
        }
      });

      child.on('close', () => {
        try { controller.close(); } catch { /* already closed */ }
      });

      child.on('error', (err) => {
        controller.error(err);
      });

      setTimeout(() => {
        child.kill('SIGTERM');
        try { controller.close(); } catch { /* already closed */ }
      }, timeoutMs);
    },
  });
}

/**
 * Check if Claude CLI is available and working.
 */
export async function checkClaudeCli(): Promise<boolean> {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('claude', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
