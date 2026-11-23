import type { Message, ModelEvent, ModelProvider, ModelRequest, ToolCall, Usage } from "./types.ts";

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}
export interface OpenAIOptions {
  /** Full endpoint, e.g. https://api.deepseek.com/chat/completions. */
  endpoint: string;
  apiKey?: string | (() => string | Promise<string>);
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Maximum gap between response bytes, rather than total generation duration. */
  idleTimeoutMs?: number;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Text + tool streaming for OpenAI-compatible chat/completions; no SDK or model catalog dependency. */
export class OpenAIProvider implements ModelProvider {
  constructor(private readonly options: OpenAIOptions) {
    const url = new URL(options.endpoint);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid model endpoint");
  }
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = typeof this.options.apiKey === "function" ? await this.options.apiKey() : this.options.apiKey;
    signal.throwIfAborted();
    const messages = request.messages.map(message => ({
      role: message.role, content: message.content || (message.toolCalls?.length ? null : ""),
      ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
      })) } : {}),
    }));
    const deadline=new AbortController();
    const timer=setTimeout(()=>deadline.abort(new ProviderError("Model response headers timed out",true)),this.options.timeoutMs ?? 600_000);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.options.endpoint, {
        method: "POST", signal: combined,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...this.options.headers },
        body: JSON.stringify({
          model: request.model, messages, stream: true, stream_options: { include_usage: true },
          max_tokens: request.maxOutputTokens,
          ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) } : {}),
        }),
      });
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      throw new ProviderError(error instanceof Error ? error.message : String(error), true);
    } finally {clearTimeout(timer);}
    if (!response.ok) {
      // Avoid exposing response bodies, which can contain credentials or full request payloads.
      await response.body?.cancel();
      throw new ProviderError(`Model HTTP ${response.status}`, [408, 429].includes(response.status) || response.status >= 500);
    }
    if (!response.body) throw new ProviderError("Model returned no response body");
    yield* readOpenAIResponse(response,signal,this.options.idleTimeoutMs);
  }
}

/** Parse a fetched response without starting another request or total-duration timer. */
export async function* readOpenAIResponse(response:Response,signal:AbortSignal,idleTimeoutMs=120_000):AsyncGenerator<ModelEvent> {
    if(!response.body) throw new ProviderError("Model returned no response body");
    const reader = response.body.getReader();
    const abort=()=>{void reader.cancel().catch(()=>undefined);};
    signal.addEventListener("abort",abort,{once:true});
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const calls = new Map<number, ToolCall>();
    let finish: "stop" | "tools" | "length" | undefined;
    let usage: Usage | undefined;
    const process = (frame: string): ModelEvent[] => {
      const data = frame.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return [];
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new ProviderError("Malformed model stream JSON"); }
      const chunk = object(parsed);
      if (chunk.error) throw new ProviderError("Model reported a streaming error");
      const u = object(chunk.usage);
      if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
        usage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
      }
      const choice = object(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
      const delta = object(choice.delta);
      const events: ModelEvent[] = [];
      if (typeof delta.content === "string") { content += delta.content; events.push({ type: "text", delta: delta.content }); }
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content; events.push({ type: "reasoning", delta: delta.reasoning_content });
      }
      for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const part = object(item);
        if (!Number.isSafeInteger(part.index) || Number(part.index) < 0) throw new ProviderError("Invalid streamed tool index");
        const index = Number(part.index);
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = object(part.function);
        if (typeof part.id === "string") call.id += part.id;
        if (typeof fn.name === "string") call.name += fn.name;
        if (typeof fn.arguments === "string") call.arguments += fn.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason === "length") finish = "length";
      else if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") finish = calls.size ? "tools" : "stop";
      else if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        throw new ProviderError(`Unsupported finish reason: ${String(choice.finish_reason)}`);
      }
      return events;
    };
    try {
      while (true) {
        signal.throwIfAborted();
        let idle:ReturnType<typeof setTimeout>|undefined;
        const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{
          idle=setTimeout(()=>reject(new ProviderError(`Model stream idle timeout: no data for ${idleTimeoutMs}ms`,!content&&!reasoning&&!calls.size)),idleTimeoutMs);
        })]).finally(()=>clearTimeout(idle));
        signal.throwIfAborted();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        // Normalize only once a full line exists, including CR/LF split across chunks.
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          for (const event of process(buffer.slice(0, boundary))) yield event;
          buffer = buffer.slice(boundary + 2);
        }
        if (buffer.length > 8_000_000) throw new ProviderError("Model stream frame too large");
        if (chunk.done) break;
      }
      if (buffer.trim()) for (const event of process(buffer)) yield event;
      if (!finish) throw new ProviderError("Model stream ended before a finish reason", !content && !reasoning && !calls.size);
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (toolCalls.some(call => !call.id || !call.name)) throw new ProviderError("Incomplete streamed tool call");
      const message: Message = { role: "assistant", content,
        ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
      yield { type: "response", message, finish, ...(usage ? { usage } : {}) };
    } catch(error) {
      if(signal.aborted)throw signal.reason;
      if(error instanceof ProviderError)throw error;
      throw new ProviderError(error instanceof Error?error.message:"Model stream read failed",!content&&!reasoning&&!calls.size);
    } finally {
      signal.removeEventListener("abort",abort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
}
