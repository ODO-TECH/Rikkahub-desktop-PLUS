// api/default-models-toggles.test.ts — settings/default-models 的字段合并锁。
// 覆盖三族语义:① 快速模型子功能开关(非布尔值与缺省键不得覆盖现值,老前端/其他调用方
// 不回传布尔时现值保持);② 全局嵌入 / 重排场景档(缺省键保持、显式空串清空、写入侧不校验);
// ③ DeepSeek 官方 OCR 的开关 / Key / 识别用途(同族口径,但值域外不覆盖现值)。
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RIKKAHUB_PC_DATA_DIR = mkdtempSync(join(tmpdir(), "rkh-default-models-test-"));

import { defaultSettings } from "../app-config/defaults";
import type { State } from "../foundation/types";
import { setState, state } from "../persistence/json-store";
import { handleSettingsRoutes } from "./handlers/settings";

async function postDefaultModels(body: Record<string, unknown>): Promise<Response | null> {
  const url = new URL("http://127.0.0.1/api/settings/default-models");
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleSettingsRoutes(request, url, "settings/default-models");
}

beforeAll(() => {
  setState({
    settings: {
      ...defaultSettings(),
      enableSuggestion: true,
      titleGenerationEnabled: true,
    },
  } as unknown as State);
});

describe("settings/default-models 子功能开关持久化", () => {
  test("布尔值落库:两开关可关", async () => {
    const res = await postDefaultModels({ enableSuggestion: false, titleGenerationEnabled: false });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(false);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("缺省键不动现值:只回传一个开关时另一个保持", async () => {
    const res = await postDefaultModels({ enableSuggestion: true });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });

  test("非布尔值被拒绝消化(不覆盖现值)", async () => {
    const res = await postDefaultModels({ enableSuggestion: "yes", titleGenerationEnabled: 1 });
    expect(res?.status).toBe(200);
    expect(state.settings.enableSuggestion).toBe(true);
    expect(state.settings.titleGenerationEnabled).toBe(false);
  });
});

// 全局「嵌入 / 重排」场景档:特性 C 的向量索引与召回只读这两档,端点漏合并 = 面板选了也不落库。
// 与 OCR/生图同口径(写入侧不校验 id 是否存在),但必须能显式清空回「未设置」。
describe("settings/default-models 嵌入 / 重排场景档持久化", () => {
  test("默认未配置(空串)", () => {
    expect(state.settings.embeddingModelId).toBe("");
    expect(state.settings.rerankModelId).toBe("");
  });

  test("两档可同时落库", async () => {
    const res = await postDefaultModels({
      embeddingModelId: "emb-uuid-1",
      rerankModelId: "rerank-uuid-1",
    });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("emb-uuid-1");
    expect(state.settings.rerankModelId).toBe("rerank-uuid-1");
  });

  test("缺省键不动现值:只回传嵌入时重排保持", async () => {
    const res = await postDefaultModels({ embeddingModelId: "emb-uuid-2" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("emb-uuid-2");
    expect(state.settings.rerankModelId).toBe("rerank-uuid-1");
  });

  test("显式空串可清除回未设置", async () => {
    const res = await postDefaultModels({ embeddingModelId: "", rerankModelId: "" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("");
    expect(state.settings.rerankModelId).toBe("");
  });

  test("写入侧不校验模型是否存在(失效 id 交给读取方兜底)", async () => {
    const res = await postDefaultModels({ embeddingModelId: "已被删除的模型 id" });
    expect(res?.status).toBe(200);
    expect(state.settings.embeddingModelId).toBe("已被删除的模型 id");
  });
});

// DeepSeek 官方 OCR(专题:OCR 模型栏目里的可选引擎)。三档语义都在 media/ocr.ts 判定,
// 写入侧只做「类型/空白/值域」归一:允许存下「开关开但 Key 空」的半成品状态,
// 由调用时给人话错误(报错档),不在保存时拦——否则用户分两次填就存不住。
describe("settings/default-models DeepSeek OCR 三字段持久化", () => {
  test("默认:关闭 + 无 Key + 逐页文本档", () => {
    expect(state.settings.deepseekOcrEnabled).toBe(false);
    expect(state.settings.deepseekOcrApiKey).toBe("");
    expect(state.settings.deepseekOcrPurpose).toBe("text_recognition");
  });

  test("三字段可同时落库,Key 两端空白被 trim", async () => {
    const res = await postDefaultModels({
      deepseekOcrEnabled: true,
      deepseekOcrApiKey: "  sk-deepseek-ocr  ",
      deepseekOcrPurpose: "rich_layout_recognition",
    });
    expect(res?.status).toBe(200);
    expect(state.settings.deepseekOcrEnabled).toBe(true);
    expect(state.settings.deepseekOcrApiKey).toBe("sk-deepseek-ocr");
    expect(state.settings.deepseekOcrPurpose).toBe("rich_layout_recognition");
  });

  test("缺省键不动现值:只关开关时 Key 与用途保持", async () => {
    const res = await postDefaultModels({ deepseekOcrEnabled: false });
    expect(res?.status).toBe(200);
    expect(state.settings.deepseekOcrEnabled).toBe(false);
    expect(state.settings.deepseekOcrApiKey).toBe("sk-deepseek-ocr");
    expect(state.settings.deepseekOcrPurpose).toBe("rich_layout_recognition");
  });

  test("显式空串可清掉 Key(删 Key 必须真的删,不能只在界面消失)", async () => {
    const res = await postDefaultModels({ deepseekOcrApiKey: "" });
    expect(res?.status).toBe(200);
    expect(state.settings.deepseekOcrApiKey).toBe("");
  });

  test("非布尔开关与值域外用途都不覆盖现值", async () => {
    await postDefaultModels({ deepseekOcrEnabled: true, deepseekOcrPurpose: "text_recognition" });
    const res = await postDefaultModels({ deepseekOcrEnabled: "yes", deepseekOcrPurpose: "layout_recognition" });
    expect(res?.status).toBe(200);
    expect(state.settings.deepseekOcrEnabled).toBe(true);
    expect(state.settings.deepseekOcrPurpose).toBe("text_recognition");
  });

  test("「开关开 + Key 空」这种半成品状态允许保存(拦截点在调用侧,不在写入侧)", async () => {
    await postDefaultModels({ deepseekOcrApiKey: "" });
    const res = await postDefaultModels({ deepseekOcrEnabled: true });
    expect(res?.status).toBe(200);
    expect(state.settings.deepseekOcrEnabled).toBe(true);
    expect(state.settings.deepseekOcrApiKey).toBe("");
  });
});
