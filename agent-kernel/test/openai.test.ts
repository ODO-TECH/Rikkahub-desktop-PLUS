import { describe, expect, test } from "bun:test";
import { OpenAIProvider, ProviderError } from "../src/index.ts";
import type { ModelEvent, ModelRequest } from "../src/index.ts";

const request: ModelRequest = { model: "test", messages: [{ role: "user", content: "hello" }], tools: [], maxOutputTokens: 100 };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const finish = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
function response(text: string, size = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(index, index += size));
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function collect(provider: OpenAIProvider): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream(request, new AbortController().signal)) events.push(event);
  return events;
}
const mockFetch = (work: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): typeof fetch => work as typeof fetch;

describe("OpenAI compatible provider", () => {
  test("fragmented UTF-8 and CRLF stream, reasoning, and trailing usage", async () => {
    let encoded: Record<string, unknown> = {};
    const provider = new OpenAIProvider({ endpoint: "https://model.example/chat/completions", apiKey: async () => "secret",
      fetch: mockFetch(async (_input, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
        encoded = JSON.parse(String(init?.body));
        return response(frame({ choices: [{ delta: { reasoning_content: "思考" } }] }) +
          frame({ choices: [{ delta: { content: "你好" } }] }) + finish +
          frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } }) + "data: [DONE]\r\n\r\n", 1);
      }),
    });
    const events = await collect(provider);
    expect(encoded.model).toBe("test");
    expect(events.at(-1)).toEqual({ type: "response", message: { role: "assistant", content: "你好", reasoning: "思考" },
      finish: "stop", usage: { inputTokens: 20, outputTokens: 4 } });
  });

  test("interleaved tool fragments reconstruct arguments and preserve call order", async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "read", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"file"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const provider = new OpenAIProvider({ endpoint: "http://localhost/chat/completions",
      fetch: mockFetch(async () => response(chunks.map(frame).join(""))) });
    const result = (await collect(provider)).at(-1);
    expect(result?.type).toBe("response");
    if (result?.type !== "response") throw new Error("No result");
    expect(result.message.toolCalls).toEqual([
      { id: "a", name: "read", arguments: "{}" }, { id: "b", name: "read", arguments: '{"path":"file"}' },
    ]);
  });

  test("abrupt EOF and malformed JSON fail instead of treating a partial answer as complete", async () => {
    const provider = new OpenAIProvider({ endpoint: "http://localhost/model",
      fetch: mockFetch(async () => response(frame({ choices: [{ delta: { content: "partial" } }] }))) });
    await expect(collect(provider)).rejects.toThrow("finish reason");
    const malformed = new OpenAIProvider({ endpoint: "http://localhost/model",
      fetch: mockFetch(async () => response("data: {bad}\n\n")) });
    await expect(collect(malformed)).rejects.toThrow("Malformed");
  });

  test("HTTP errors classify retries and do not expose response secrets", async () => {
    const provider = new OpenAIProvider({ endpoint: "https://model.example/chat/completions",
      fetch: mockFetch(async () => new Response("secret API key", { status: 429 })) });
    try { await collect(provider); throw new Error("Expected failure"); } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(true);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  test("cancellation reaches fetch and does not become a retryable network failure", async () => {
    const signal = new AbortController();
    const provider = new OpenAIProvider({ endpoint: "http://localhost/model", fetch: mockFetch(async (_input, init) => {
      signal.abort(new Error("cancelled"));
      init?.signal?.throwIfAborted();
      return response(finish);
    }) });
    const consume = async () => { for await (const _event of provider.stream(request, signal.signal)) { /* drain */ } };
    await expect(consume()).rejects.toThrow("cancelled");
  });
});
