import { resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptTurnRenderOptions } from "../src/core/extensions/types.ts";
import { TranscriptTurnComponent } from "../src/modes/interactive/components/transcript-turn.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const imageConversion = vi.hoisted(() => ({
	convertToPng: vi.fn<(data: string, mimeType: string) => Promise<{ data: string; mimeType: string } | undefined>>(),
}));

vi.mock("../src/utils/image-convert.ts", () => ({ convertToPng: imageConversion.convertToPng }));

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("TranscriptTurnComponent", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		resetCapabilitiesCache();
		imageConversion.convertToPng.mockReset();
	});

	test("rebuilds one extension-owned surface as an in-progress turn changes", () => {
		const component = new TranscriptTurnComponent(
			(turn) =>
				new Text(
					`${turn.isStreaming ? "working" : "done"}: ${turn.messages.length} messages / ${turn.toolExecutions.length} tools`,
					0,
					0,
				),
			1,
			false,
			80,
			{ requestRender() {} } as never,
		);

		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: true });
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("working: 0 messages / 0 tools");

		component.update({
			messages: [
				{
					role: "assistant",
					content: [],
					api: "test",
					provider: "test",
					model: "test",
					usage: {} as never,
					stopReason: "toolUse",
					timestamp: 0,
				},
			],
			customEntries: [],
			toolExecutions: [{ toolCallId: "call-1", toolName: "bash", args: { command: "pwd" }, isPartial: true }],
			isStreaming: true,
		});
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("working: 1 messages / 1 tools");

		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: false });
		expect(stripAnsi(component.render(100).join("\n")).trimEnd()).toBe("done: 0 messages / 0 tools");
	});

	test("initializes expansion and propagates live render settings", () => {
		const options: TranscriptTurnRenderOptions[] = [];
		const component = new TranscriptTurnComponent(
			(_turn, renderOptions) => {
				options.push({ ...renderOptions });
				return new Text("summary", 0, 0);
			},
			1,
			true,
			80,
			{ requestRender() {} } as never,
			true,
		);
		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: false });
		expect(options.at(-1)).toEqual({ expanded: true, outputPad: 1, showImages: true });
		component.setExpanded(false);
		component.setOutputPad(0);
		component.setShowImages(false);
		expect(options.at(-1)).toEqual({ expanded: false, outputPad: 0, showImages: false });
	});

	test("deduplicates pending and failed Kitty image conversions across streaming rebuilds", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveConversion: (value: undefined) => void = () => {};
		imageConversion.convertToPng.mockReturnValue(
			new Promise((resolve) => {
				resolveConversion = resolve;
			}),
		);
		const component = new TranscriptTurnComponent(() => new Text("summary", 0, 0), 1, true, 80, {
			requestRender() {},
		} as never);
		const turn = {
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "image-call",
					toolName: "read-image",
					args: {},
					result: {
						content: [{ type: "image" as const, data: "jpeg-a", mimeType: "image/jpeg" }],
						isError: false,
					},
					isPartial: false,
				},
			],
			isStreaming: true,
		};
		for (let index = 0; index < 10; index += 1) component.update(turn);
		expect(imageConversion.convertToPng).toHaveBeenCalledTimes(1);

		resolveConversion(undefined);
		await Promise.resolve();
		component.update(turn);
		expect(imageConversion.convertToPng).toHaveBeenCalledTimes(1);

		imageConversion.convertToPng.mockResolvedValue(undefined);
		component.update({
			...turn,
			toolExecutions: [
				{
					...turn.toolExecutions[0],
					result: { content: [{ type: "image", data: "jpeg-b", mimeType: "image/jpeg" }], isError: false },
				},
			],
		});
		expect(imageConversion.convertToPng).toHaveBeenCalledTimes(2);
	});

	test("falls back to stock content and keeps native images when a renderer throws", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const component = new TranscriptTurnComponent(
			() => {
				throw new Error("broken renderer");
			},
			1,
			true,
			80,
			{ requestRender() {} } as never,
			false,
			() => new Text("stock assistant and tool rows", 0, 0),
		);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "image-call",
					toolName: "read-image",
					args: {},
					result: { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], isError: false },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		const rendered = component.render(100).join("\n");
		expect(stripAnsi(rendered)).toContain("Transcript turn renderer failed");
		expect(stripAnsi(rendered)).toContain("stock assistant and tool rows");
		expect(rendered).toContain("\u001b]1337;File=");
		component.setShowImages(false);
		expect(component.render(100).join("\n")).not.toContain("\u001b]1337;File=");
		component.setImageWidthCells(20);
		component.setShowImages(true);
		expect(component.render(100).join("\n")).toContain("\u001b]1337;File=");
	});
});
