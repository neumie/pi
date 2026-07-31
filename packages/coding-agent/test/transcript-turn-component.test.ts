import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { TranscriptTurnComponent } from "../src/modes/interactive/components/transcript-turn.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TranscriptTurnComponent", () => {
	beforeAll(() => initTheme("dark"));

	test("rebuilds one extension-owned surface as an in-progress turn changes", () => {
		const component = new TranscriptTurnComponent(
			(turn) => new Text(`${turn.isStreaming ? "working" : "done"}: ${turn.messages.length} messages / ${turn.toolExecutions.length} tools`, 0, 0),
			1,
			false,
			60,
			{ requestRender() {} } as never,
		);

		component.update({ messages: [], toolExecutions: [], isStreaming: true });
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("working: 0 messages / 0 tools");

		component.update({
			messages: [{ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {} as never, stopReason: "toolUse", timestamp: 0 }],
			toolExecutions: [{ toolCallId: "call-1", toolName: "bash", args: { command: "pwd" }, isPartial: true }],
			isStreaming: true,
		});
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("working: 1 messages / 1 tools");

		component.update({ messages: [], toolExecutions: [], isStreaming: false });
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("done: 0 messages / 0 tools");
	});
});
