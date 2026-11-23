import { AgentRuntime, answerOf, KernelStore, OpenAIProvider, Superagent } from "../src/index.ts";
import type { ModelProvider } from "../src/index.ts";

// Works without a network or API key; set MODEL_ENDPOINT + MODEL_NAME to use a real model.
const local: ModelProvider = {
  async *stream(request) {
    const text = `Completed: ${request.messages.at(-1)?.content ?? ""}`;
    yield { type: "text", delta: text };
    yield { type: "response", message: { role: "assistant", content: text }, finish: "stop" };
  },
};
const provider = process.env.MODEL_ENDPOINT ? new OpenAIProvider({
  endpoint: process.env.MODEL_ENDPOINT, apiKey: process.env.MODEL_API_KEY,
}) : local;
const store = new KernelStore();
try {
  const runtime = new AgentRuntime({ store, provider });
  const model = process.env.MODEL_NAME ?? "local";
  const result = await runtime.start({ model, input: "Explain what this kernel does in one sentence." });
  console.log(result.status, answerOf(result));
  const supervisor = new Superagent({ runtime });
  const ticket = supervisor.accept({ source: "demo", triggerId: crypto.randomUUID(), model,
    prompt: "Review a design and summarize it.", tasks: [
      { id: "review", prompt: "List two useful design checks." },
      { id: "summary", prompt: "Summarize the review.", dependsOn: ["review"] },
    ] });
  console.log("Ticket:", (await supervisor.advance(ticket.id)).status);
  await supervisor.flush(async delivery => { console.log("Delivery:", delivery.content); });
} finally { store.close(); }
