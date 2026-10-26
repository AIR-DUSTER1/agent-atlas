import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { runGraphEvents } from "../../src/server/stream.js";
import type { AgentEvent } from "../../src/server/events.js";

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
