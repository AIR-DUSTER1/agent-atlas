import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { config } from "../../src/config.js";
import { runGraphEvents } from "../../src/server/stream.js";
import type { AgentEvent } from "../../src/server/events.js";

test("stream：把可配置的长任务递归保护传给 LangGraph", async () => {
  let seenOptions: Record<string, unknown> | undefined;
  const graph = {
    stream: async (_input: unknown, options: Record<string, unknown>) => {
      seenOptions = options;
      return (async function* () {})();
    },
  };
  for await (const _event of runGraphEvents(graph, {}, { threadId: "long-task-limit-test" })) {
    // 空流也必须正常结束；本用例只校验传给 LangGraph 的运行参数。
  }
  assert.equal(seenOptions?.recursionLimit, config.agentRecursionLimit);
  assert.ok((seenOptions?.recursionLimit as number) >= 100);
});

test("stream：过滤内部模型节点，保留可见回答与澄清 interrupt", async () => {
  const graph = {
    stream: async () =>
      (async function* () {
        yield [
          "messages",
          [
            new AIMessageChunk({
              id: "internal",
              content: '{"understood":false}',
              additional_kwargs: { reasoning_content: "先判断需求" },
            }),
            { langgraph_node: "analyze", checkpoint_ns: "analyze" },
          ],
        ];
        yield [
          "updates",
          {
            analyze: {
              messages: [
                new AIMessage({
                  id: "internal",
                  content: '{"understood":false}',
                  additional_kwargs: { reasoning_content: "先判断需求" },
                }),
              ],
            },
          },
        ];
        yield [
          "messages",
          [
            new AIMessageChunk({
              id: "visible",
              content: "最终回答",
              additional_kwargs: { reasoning_content: "整理答案" },
            }),
            { langgraph_node: "agent", checkpoint_ns: "agent" },
          ],
        ];
        yield [
          "messages",
          [
            new AIMessageChunk({
              id: "thinking-block",
              content: [
                { type: "thinking", thinking: "块式思考" },
                { type: "text", text: "块式回答" },
              ] as never,
            }),
            { langgraph_node: "agent", checkpoint_ns: "agent" },
          ],
        ];
        yield [
          "updates",
          {
            __interrupt__: [
              {
                value: {
                  type: "clarification",
                  question: "先看哪个城市？",
                  options: [
                    { id: "A", label: "北京" },
                    { id: "B", label: "上海" },
                  ],
                  allowCustom: true,
                },
              },
            ],
          },
        ];
      })(),
  };

  const events: AgentEvent[] = [];
  for await (const event of runGraphEvents(graph, {}, { threadId: "stream-test" })) {
    events.push(event);
  }

  const tokens = events.filter((event) => event.type === "token");
  assert.deepEqual(tokens.map((event) => event.text), ["最终回答", "块式回答"], "思考 block 不能混入正文");
  const reasoning = events.filter((event) => event.type === "reasoning");
  assert.deepEqual(reasoning.map((event) => event.text), ["先判断需求", "整理答案", "块式思考"]);
  assert.deepEqual(reasoning.map((event) => event.node), ["analyze", "agent", "agent"]);
  assert.equal(events.filter((event) => event.type === "ai_message").length, 0, "内部 JSON 正文仍必须过滤");
  const interrupt = events.find((event) => event.type === "interrupt");
  assert.equal(interrupt?.type, "interrupt");
  assert.equal(interrupt?.type === "interrupt" ? interrupt.payload.type : "", "clarification");
  assert.equal(events.at(-1)?.type, "done");
});

test("stream：重复 usage 快照不重复产出，工具返回后生成新的 callId", async () => {
  const graph = {
    stream: async () =>
      (async function* () {
        const usageChunk = new AIMessageChunk({
          id: "call-1",
          content: "",
          usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_token_details: { cache_read: 20 } },
        });
        yield ["messages", [usageChunk, { langgraph_node: "agent", checkpoint_ns: "agent" }]];
        yield ["messages", [usageChunk, { langgraph_node: "agent", checkpoint_ns: "agent" }]];
        yield [
          "messages",
          [
            new ToolMessage({ content: "工具完成", tool_call_id: "tool-1", name: "read_file" }),
            { langgraph_node: "agent", checkpoint_ns: "agent" },
          ],
        ];
        yield [
          "messages",
          [
            new AIMessageChunk({
              id: "call-2",
              content: "最终回答",
              usage_metadata: { input_tokens: 160, output_tokens: 30, total_tokens: 190, input_token_details: { cache_read: 40 } },
            }),
            { langgraph_node: "agent", checkpoint_ns: "agent" },
          ],
        ];
      })(),
  };

  const events: AgentEvent[] = [];
  for await (const event of runGraphEvents(graph, {}, { threadId: "usage-dedupe-test" })) {
    events.push(event);
  }
  const usage = events.filter((event) => event.type === "usage");
  assert.equal(usage.length, 2, "同一快照重复出现不应增加调用次数");
  assert.deepEqual(usage.map((event) => event.callId), ["usage-1", "usage-2"]);
  assert.deepEqual(usage.map((event) => [event.inputTokens, event.outputTokens, event.cacheReadTokens]), [
    [100, 10, 20],
    [160, 30, 40],
  ]);
  assert.ok(usage.every((event) => event.internal === false && event.node === "agent"));
});

test("stream：自主审查 usage 从 ToolMessage 转发并跨双流去重", async () => {
  const toolMessage = new ToolMessage({
    id: "risk-tool-message",
    content: "工具完成",
    tool_call_id: "tool-1",
    name: "terminal",
    additional_kwargs: {
      riskUsage: { inputTokens: 300, outputTokens: 20, totalTokens: 320, cacheReadTokens: 100 },
      riskCallId: "risk:thread:tool-1",
    },
  });
  const graph = {
    stream: async () =>
      (async function* () {
        yield ["messages", [toolMessage, { langgraph_node: "tools", checkpoint_ns: "tools" }]];
        yield ["updates", { tools: { messages: [toolMessage] } }];
      })(),
  };

  const events: AgentEvent[] = [];
  for await (const event of runGraphEvents(graph, {}, { threadId: "risk-usage-test" })) {
    events.push(event);
  }
  const usage = events.filter((event) => event.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].callId, "risk:thread:tool-1");
  assert.deepEqual([usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheReadTokens], [300, 20, 100]);
  assert.equal(usage[0].internal, true);
  assert.equal(usage[0].node, "tools");
  assert.equal(events.filter((event) => event.type === "tool_result").length, 2);
});

test("stream：自主低风险放行产出 risk_decision，跨 messages/updates 只一次", async () => {
  const toolMessage = new ToolMessage({
    id: "auto-risk-tool-message",
    content: "工具完成",
    tool_call_id: "tool-auto",
    name: "terminal",
    additional_kwargs: {
      riskDecision: "auto",
      riskReason: "只读取工作区状态，可恢复",
      riskCallId: "risk:thread-auto:tool-auto",
    },
  });
  const graph = {
    stream: async () =>
      (async function* () {
        yield ["messages", [toolMessage, { langgraph_node: "tools", checkpoint_ns: "tools" }]];
        yield ["updates", { tools: { messages: [toolMessage] } }];
      })(),
  };
  const events: AgentEvent[] = [];
  for await (const event of runGraphEvents(graph, {}, { threadId: "risk-decision-test" })) events.push(event);
  const decisions = events.filter((event) => event.type === "risk_decision");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].type === "risk_decision" ? decisions[0].toolName : "", "terminal");
  assert.match(decisions[0].type === "risk_decision" ? decisions[0].reason : "", /可恢复/);
});

test("stream：tools 节点风险审查 JSON 不进入用户正文，但工具结果仍保留", async () => {
  const graph = {
    stream: async () =>
      (async function* () {
        yield ["messages", [
          new AIMessageChunk({
            id: "risk-json",
            content: '{"highRisk":false,"reason":"只读查询"}',
            usage_metadata: { input_tokens: 80, output_tokens: 12, total_tokens: 92 },
          }),
          { langgraph_node: "tools", checkpoint_ns: "tools" },
        ]];
        yield ["messages", [
          new ToolMessage({ content: "命令输出", tool_call_id: "tool-1", name: "terminal" }),
          { langgraph_node: "tools", checkpoint_ns: "tools" },
        ]];
      })(),
  };
  const events: AgentEvent[] = [];
  for await (const event of runGraphEvents(graph, {}, { threadId: "risk-json-filter" })) events.push(event);
  assert.equal(events.filter((event) => event.type === "token" || event.type === "ai_message").length, 0);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  const usage = events.filter((event) => event.type === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].internal, true);
});
