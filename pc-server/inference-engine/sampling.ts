// inference-engine/sampling.ts — 采样参数出线口径
//
// 为什么要有这一层:Kelivo / 安卓侧的助手 JSON 用 0 表示"未设置"(topP=0、maxTokens=0),
// 而 OpenAI / Anthropic / Gemini 这些上游会把 0 当成字面值执行——
//   top_p=0      → 概率质量 0,几乎不可能抽到任何 token;
//   max_tokens=0 → 输出上限 0。
// SiliconFlow(Qwen3-VL)实测:请求 200,响应流里一个 text delta 都没有,前端最终显示
// "(empty response)"。这不是网络/解析问题,是"未设置哨兵被当成有效值"发给了上游。
//
// 口径:
// - topP:只有 (0, 1] 才是有效值;0 / 负数 / 越界一律视为未设置(不发这个字段)。
// - maxTokens:只有 > 0 才是有效值;0 / 负数视为未设置。
// - temperature:不做处理——0 是完全合法的确定性采样,不能当"未设置"。

/** 有效 topP;无效(含 0 哨兵)返回 undefined(调用方据此省略字段)。 */
export function effectiveTopP(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined;
}

/** 有效输出上限;无效(含 0 哨兵)返回 undefined。 */
export function effectiveMaxTokens(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
