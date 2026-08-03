import { resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptTurnRenderOptions } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	getTranscriptToolExecution,
	getTranscriptToolResultTextContent,
	TranscriptTurnComponent,
} from "../src/modes/interactive/components/transcript-turn.ts";
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

	test("coalesces updates until render and exposes the latest settled state", () => {
		const renderer = vi.fn((turn) => new Text(`${turn.messages.length}:${turn.isStreaming}`, 0, 0));
		const requestRender = vi.fn();
		const component = new TranscriptTurnComponent(renderer, 1, false, 80, { requestRender } as never);
		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: true });
		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: false });
		expect(renderer).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledOnce();
		expect(stripAnsi(component.render(100).join("\n")).trim()).toBe("0:false");
		expect(renderer).toHaveBeenCalledOnce();
	});

	test("defers reentrant updates to the next frame without installing stale output", () => {
		const component = new TranscriptTurnComponent(
			(turn) => {
				if (turn.isStreaming) {
					component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: false });
					return new Text("stale", 0, 0);
				}
				return new Text("latest", 0, 0);
			},
			1,
			false,
			80,
			{ requestRender() {} } as never,
		);
		component.update({ messages: [], customEntries: [], toolExecutions: [], isStreaming: true });
		expect(component.render(100)).toEqual([]);
		expect(stripAnsi(component.render(100).join("\n")).trim()).toBe("latest");
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
		component.render(100);
		expect(options.at(-1)).toEqual({ expanded: true, outputPad: 1, showImages: true });
		component.setExpanded(false);
		component.setOutputPad(0);
		component.setShowImages(false);
		component.render(100);
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
		component.render(100);
		expect(imageConversion.convertToPng).toHaveBeenCalledTimes(1);

		resolveConversion(undefined);
		await Promise.resolve();
		component.update(turn);
		component.render(100);
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
		component.render(100);
		expect(imageConversion.convertToPng).toHaveBeenCalledTimes(2);
	});

	test("gives renderers detached snapshots while fallback and images retain host details", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const source = {
			messages: [
				{
					role: "custom",
					customType: "status",
					content: { nested: { value: "message" } },
					display: true,
					timestamp: 0,
				},
			] as never,
			customEntries: [
				{
					type: "custom",
					id: "entry",
					parentId: null,
					timestamp: "0",
					customType: "status",
					data: { nested: "entry" },
				},
			] as never,
			toolExecutions: [
				{
					toolCallId: "image-call",
					toolName: "read-image",
					args: { nested: { value: "args" } },
					result: {
						content: [{ type: "image" as const, data: PNG_1X1, mimeType: "image/png" }],
						details: { diff: "original diff" },
						isError: false,
					},
					isPartial: false,
				},
			],
			isStreaming: false,
		};
		let fallbackCalls = 0;
		const fallback = (turn: Parameters<NonNullable<ConstructorParameters<typeof TranscriptTurnComponent>[6]>>[0]) => {
			fallbackCalls += 1;
			const execution = getTranscriptToolExecution(turn.toolExecutions, "image-call");
			expect((execution?.args as { nested: { value: string } }).nested.value).toBe("args");
			expect(execution?.result?.details).toEqual({ diff: "original diff" });
			return new Text("stock", 0, 0);
		};
		const component = new TranscriptTurnComponent(
			(turn) => {
				expect("details" in (turn.toolExecutions[0]?.result ?? {})).toBe(false);
				(turn.toolExecutions[0]?.args as { nested: { value: string } }).nested.value = "mutated";
				(turn.messages[0] as unknown as { content: { nested: { value: string } } }).content.nested.value =
					"mutated";
				(turn.customEntries[0]?.data as { nested: string }).nested = "mutated";
				const image = turn.toolExecutions[0]?.result?.content[0];
				if (image?.type === "image") image.data = "mutated";
				throw new Error("broken renderer");
			},
			1,
			true,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		component.update(source);
		component.render(100);
		expect(fallbackCalls).toBe(1);
		expect(source).toMatchObject({
			messages: [{ content: { nested: { value: "message" } } }],
			customEntries: [{ data: { nested: "entry" } }],
			toolExecutions: [
				{
					args: { nested: { value: "args" } },
					result: {
						content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
						details: { diff: "original diff" },
					},
				},
			],
		});
		expect(component.render(100).join("\n")).toContain("\u001b]1337;File=");
	});

	test("passes host result details to stock edit rendering after a renderer failure", () => {
		const component = new TranscriptTurnComponent(
			() => {
				throw new Error("broken renderer");
			},
			1,
			false,
			80,
			{ requestRender() {} } as never,
			false,
			(turn) => {
				const execution = getTranscriptToolExecution(turn.toolExecutions, "edit-call");
				if (!execution?.result) return undefined;
				const stockTool = new ToolExecutionComponent(
					"edit",
					execution.toolCallId,
					execution.args,
					{},
					undefined,
					{ requestRender() {} } as never,
					process.cwd(),
				);
				stockTool.updateResult(execution.result, false);
				return stockTool;
			},
		);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "edit-call",
					toolName: "edit",
					args: { path: "README.md", oldText: "before", newText: "after" },
					result: {
						content: [],
						details: { diff: "@@ details-dependent fallback @@\n+ preserved detail", firstChangedLine: 1 },
						isError: false,
					},
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		expect(stripAnsi(component.render(120).join("\n"))).toContain("preserved detail");
	});

	test("fails closed to stock rendering for non-cloneable renderer input while retaining native images", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			true,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "call",
					toolName: "tool",
					args: { callback: () => {} },
					result: { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], isError: false },
					isPartial: true,
				},
			],
			isStreaming: true,
		});
		expect(renderer).not.toHaveBeenCalled();
		const rendered = component.render(100).join("\n");
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
		expect(stripAnsi(rendered)).toContain("could not be snapshotted");
		expect(rendered).toContain("\u001b]1337;File=");
	});

	test("fails closed for budget, depth, and shared-memory snapshots while allowing cycles", () => {
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			false,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "cycle", toolName: "tool", args: cyclic, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).toHaveBeenCalledOnce();
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "image",
					toolName: "tool",
					args: {},
					result: {
						content: [{ type: "image", data: "a".repeat(Math.floor(4.5 * 1024 * 1024)), mimeType: "image/png" }],
						isError: false,
					},
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).toHaveBeenCalledTimes(2);
		const deep: { child?: unknown } = {};
		let current = deep;
		for (let index = 0; index <= 256; index += 1) {
			current.child = {};
			current = current.child as { child?: unknown };
		}
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "deep", toolName: "tool", args: deep, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledOnce();
		const shared = new SharedArrayBuffer(16);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "shared", toolName: "tool", args: new Uint8Array(shared), isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledTimes(2);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{ toolCallId: "large", toolName: "tool", args: "x".repeat(9 * 1024 * 1024), isPartial: false },
			],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledTimes(3);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{ toolCallId: "work", toolName: "tool", args: Array.from({ length: 100_001 }, () => 0), isPartial: false },
			],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledTimes(4);
	});

	test("bounds public snapshots without traversing ignored binary views", () => {
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			false,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		const bytes = new Uint8Array(8 * 1024 * 1024);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "bytes", toolName: "tool", args: bytes, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).toHaveBeenCalledOnce();
		const supported: { map: Map<string, unknown> } = { map: new Map([["key", new Set([new ArrayBuffer(8)])]]) };
		supported.map.set("self", supported);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "supported", toolName: "tool", args: supported, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).toHaveBeenCalledTimes(2);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "bigint", toolName: "tool", args: 1n, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledOnce();
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "property",
					toolName: "tool",
					args: { ["x".repeat(9 * 1024 * 1024)]: true },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		component.render(100);
		expect(fallback).toHaveBeenCalledTimes(2);
		const sparse = [] as unknown[];
		sparse.length = 1_000_000;
		let getterCalls = 0;
		Object.defineProperty(sparse, "0", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return "never";
			},
		});
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "sparse", toolName: "tool", args: sparse, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(getterCalls).toBe(0);
		expect(fallback).toHaveBeenCalledTimes(3);
		const executions = [] as unknown[];
		executions.length = 1;
		Object.defineProperty(executions, "0", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return {};
			},
		});
		component.update({ messages: [], customEntries: [], toolExecutions: executions as never, isStreaming: false });
		component.render(100);
		expect(getterCalls).toBe(0);
		expect(fallback).toHaveBeenCalledTimes(4);
	});

	test("accounts for Map allocation and rejects excessive plain-object properties", () => {
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			false,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		const entries = new Map<number, number>();
		for (let index = 0; index < 24_900; index += 1) entries.set(index, index);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "map",
					toolName: "tool",
					args: { buffer: new ArrayBuffer(15 * 1024 * 1024), entries },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
		const properties: Record<string, boolean> = {};
		for (let index = 0; index < 100_001; index += 1) properties[`key-${index}`] = true;
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "properties", toolName: "tool", args: properties, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledTimes(2);
	});

	test("keeps valid native images and stock text when malformed content rejects the snapshot", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		const content: unknown[] = [
			undefined,
			{ type: "text", text: "stock text" },
			{ type: "image" },
			{ type: "image", data: 1, mimeType: "image/png" },
		];
		let getterCalls = 0;
		Object.defineProperty(content, "4", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return { type: "image", data: PNG_1X1, mimeType: "image/png" };
			},
		});
		content[5] = { type: "image", data: PNG_1X1, mimeType: "image/png" };
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			true,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "content",
					toolName: "tool",
					args: { callback: () => {} },
					result: { content: content as never, isError: false },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		const rendered = component.render(100).join("\n");
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
		expect(getterCalls).toBe(0);
		expect(rendered).toContain("\u001b]1337;File=");
		expect(getTranscriptToolResultTextContent({ content })).toEqual([{ type: "text", text: "stock text" }]);
	});

	test("uses intrinsic buffer getters without invoking shadowed properties", () => {
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			false,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		let getterCalls = 0;
		const buffer = new ArrayBuffer(17 * 1024 * 1024);
		Object.defineProperty(buffer, "byteLength", {
			get: () => {
				getterCalls += 1;
				return 0;
			},
		});
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "buffer", toolName: "tool", args: buffer, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(getterCalls).toBe(0);
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
		const bytes = new Uint8Array(17 * 1024 * 1024);
		Object.defineProperty(bytes, "buffer", {
			get: () => {
				getterCalls += 1;
				return new ArrayBuffer(1);
			},
		});
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [{ toolCallId: "view", toolName: "tool", args: bytes, isPartial: false }],
			isStreaming: false,
		});
		component.render(100);
		expect(getterCalls).toBe(0);
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledTimes(2);
	});

	test("recovers valid images after accessor-backed execution and content entries", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
		let getterCalls = 0;
		const executions = [] as unknown[];
		executions.length = 2;
		Object.defineProperty(executions, "0", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				throw new Error("not read");
			},
		});
		executions[1] = {
			toolCallId: "valid",
			toolName: "tool",
			args: { callback: () => {} },
			result: { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], isError: false },
			isPartial: false,
		};
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const fallback = vi.fn(() => new Text("stock", 0, 0));
		const component = new TranscriptTurnComponent(
			renderer,
			1,
			true,
			80,
			{ requestRender() {} } as never,
			false,
			fallback,
		);
		component.update({ messages: [], customEntries: [], toolExecutions: executions as never, isStreaming: false });
		const rendered = component.render(100).join("\n");
		expect(getterCalls).toBe(0);
		expect(renderer).not.toHaveBeenCalled();
		expect(fallback).toHaveBeenCalledOnce();
		expect(rendered).toContain("\u001b]1337;File=");
	});

	test("retains valid text around malformed result content entries", () => {
		const content: unknown[] = [{ type: "text", text: "before" }, {}, undefined, { type: "text", text: "after" }];
		let getterCalls = 0;
		Object.defineProperty(content, "2", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				throw new Error("not read");
			},
		});
		expect(getTranscriptToolResultTextContent({ content })).toEqual([
			{ type: "text", text: "before" },
			{ type: "text", text: "after" },
		]);
		expect(getterCalls).toBe(0);
	});

	test("deactivation prevents invalidation and Kitty conversion completion from rendering", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveConversion: (value: { data: string; mimeType: string } | undefined) => void = () => {};
		imageConversion.convertToPng.mockReturnValue(
			new Promise((resolve) => {
				resolveConversion = resolve;
			}),
		);
		const renderer = vi.fn(() => new Text("extension", 0, 0));
		const requestRender = vi.fn();
		const component = new TranscriptTurnComponent(renderer, 1, true, 80, { requestRender } as never);
		component.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "image",
					toolName: "tool",
					args: {},
					result: { content: [{ type: "image", data: "jpeg", mimeType: "image/jpeg" }], isError: false },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		component.render(100);
		expect(imageConversion.convertToPng).toHaveBeenCalledOnce();
		component.deactivate();
		component.invalidate();
		resolveConversion({ data: PNG_1X1, mimeType: "image/png" });
		await Promise.resolve();
		expect(renderer).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledOnce();
		expect(component.render(100)).toEqual([]);
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
