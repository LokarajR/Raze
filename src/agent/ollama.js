'use strict';

/**
 * Local model provider.
 *
 * Uses ollama's HTTP API rather than `ollama run`, for two reasons that matter:
 *
 *   Context. The default context window is small — far smaller than a merchant
 *   file plus its findings. `ollama run` gives no way to raise it, so the prompt
 *   is silently truncated and the model returns a patch based on half the file.
 *   Over the API, num_ctx is explicit.
 *
 *   Determinism. temperature 0 makes repeated runs comparable, which matters
 *   when you are measuring whether a smaller model can do this job at all.
 *
 * A local model is weaker than a frontier one at writing a correct handler. That
 * is acceptable here precisely because the model is not trusted: the
 * deterministic probes decide whether the patch worked, and a patch that does
 * not pass is discarded. The cost of a weaker model is more rounds and more
 * outright failures, never a wrong "fixed" verdict.
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.RAZE_OLLAMA_MODEL || 'qwen2.5-coder:7b';

/** Context window. Big enough for the source, the findings and the reply. */
const NUM_CTX = Number(process.env.RAZE_OLLAMA_CTX || 16384);

async function listModels(host = DEFAULT_HOST) {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`ollama not reachable at ${host} (HTTP ${res.status})`);
  const body = await res.json();
  return (body.models || []).map((m) => m.name);
}

/**
 * Pick a model to use: the requested one if present, otherwise the best
 * available by a simple preference order, so the agent still runs on a machine
 * that happens to have a different model pulled.
 */
function chooseModel(available, requested = DEFAULT_MODEL) {
  if (available.includes(requested)) return requested;
  const exact = available.find((m) => m.split(':')[0] === requested.split(':')[0]);
  if (exact) return exact;
  const preference = ['coder', 'qwen', 'deepseek', 'codellama', 'llama', 'mistral'];
  for (const p of preference) {
    const hit = available.find((m) => m.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return available[0] || null;
}

async function generate(prompt, { host = DEFAULT_HOST, model = DEFAULT_MODEL, timeoutMs = 900000 } = {}) {
  const available = await listModels(host);
  if (available.length === 0) {
    throw new Error(`ollama has no models pulled. Try: ollama pull ${DEFAULT_MODEL}`);
  }
  const chosen = chooseModel(available, model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_ctx: NUM_CTX,
          num_predict: 4096,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = await res.json();
    const text = (body.response || '').trim();
    if (!text) throw new Error('ollama returned an empty response');

    // A truncated reply is the classic small-context failure. Say so plainly
    // rather than letting a half-file reach the syntax gate.
    if (body.done_reason === 'length') {
      throw new Error(
        `ollama hit the output limit before finishing the file (model ${chosen}). ` +
        'Raise RAZE_OLLAMA_CTX, or use a model with a larger context.'
      );
    }
    return { text, usage: { model: chosen, eval_count: body.eval_count }, model: chosen };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generate, listModels, chooseModel, DEFAULT_MODEL, DEFAULT_HOST };
