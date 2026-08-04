import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, expectTypeOf, test, vi } from "vitest";
import type { TranscriptTurn, TranscriptTurnRenderOptions } from "../src/core/extensions/types.ts";
import type { TranscriptTurnMessage } from "../src/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	type TranscriptToolExecutionSource,
	TranscriptTurnComponent,
} from "../src/modes/interactive/components/transcript-turn.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const imageConversion = vi.hoisted(() => ({
	convertToPng: vi.fn<(data: string, mimeType: string) => Promise<{ data: string; mimeType: string } | undefined>>(),
}));

vi.mock("../src/utils/image-convert.ts", () => ({ convertToPng: imageConversion.convertToPng }));

describe("InteractiveMode transcript turns", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		resetCapabilitiesCache();
		imageConversion.convertToPng.mockReset();
	});

	test("replays visible related output into one expanded surface per user turn", () => {
		const snapshots: Array<{
			messages: TranscriptTurn["messages"];
			customEntries: TranscriptTurn["customEntries"];
			toolExecutions: TranscriptTurn["toolExecutions"];
			options: TranscriptTurnRenderOptions;
			isStreaming: boolean;
		}> = [];
		const renderer = (turn: TranscriptTurn, options: TranscriptTurnRenderOptions) => {
			snapshots.push({
				messages: [...turn.messages],
				customEntries: [...turn.customEntries],
				toolExecutions: [...turn.toolExecutions],
				options: { ...options },
				isStreaming: turn.isStreaming,
			});
			return new Text(`turn:${turn.messages.length}:${turn.customEntries.length}`, 0, 0);
		};
		const prototype = InteractiveMode.prototype as any;
		const chatContainer = new Container();
		const fakeThis: any = {
			chatContainer,
			pendingTools: new Map(),
			transcriptTurnComponent: undefined,
			transcriptTurnMessages: [],
			transcriptCustomEntries: [],
			transcriptToolExecutions: new Map(),
			transcriptAssistantIndex: undefined,
			transcriptTurnStreaming: true,
			toolOutputExpanded: true,
			outputPad: 1,
			settingsManager: { getShowImages: () => false, getImageWidthCells: () => 80 },
			ui: { requestRender: vi.fn() },
			session: {
				extensionRunner: {
					getTranscriptTurnRenderer: () => renderer,
					getEntryRenderer: (customType: string) =>
						customType === "progress-card" ? () => new Text("progress", 0, 0) : undefined,
				},
			},
			addMessageToChat: vi.fn((message) => chatContainer.addChild(new Text(`user:${message.role}`, 0, 0))),
			addCustomEntryToChat: vi.fn(),
			getTranscriptTurnRenderer: prototype.getTranscriptTurnRenderer,
			renderDefaultTranscriptTurn: vi.fn(() => new Container()),
			ensureTranscriptTurnComponent: prototype.ensureTranscriptTurnComponent,
			clearTranscriptTurn: prototype.clearTranscriptTurn,
			updateTranscriptTurn: prototype.updateTranscriptTurn,
			appendTranscriptCustomEntry: prototype.appendTranscriptCustomEntry,
			updateTranscriptTool: prototype.updateTranscriptTool,
			setTranscriptTurnStreaming: prototype.setTranscriptTurnStreaming,
			settleAndClearTranscriptTurn: prototype.settleAndClearTranscriptTurn,
			reconcileTranscriptToolCalls: prototype.reconcileTranscriptToolCalls,
		};
		const items = [
			{ role: "user", content: "one", timestamp: 1 },
			{ role: "custom", customType: "visible-progress", content: "halfway", display: true, timestamp: 2 },
			{ role: "custom", customType: "hidden-state", content: "PRIVATE", display: false, timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {},
				stopReason: "stop",
				timestamp: 4,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				details: { exitCode: 0 },
				isError: false,
				timestamp: 4,
			},
			{
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "progress-card",
				data: {},
			},
			{ role: "user", content: "two", timestamp: 5 },
			{
				role: "assistant",
				content: [],
				api: "test",
				provider: "test",
				model: "test",
				usage: {},
				stopReason: "stop",
				timestamp: 6,
			},
		];

		prototype.renderTranscriptTurnItems.call(fakeThis, items, {});
		chatContainer.render(100);

		expect(chatContainer.children).toHaveLength(4);
		const firstCompleted = snapshots
			.slice()
			.reverse()
			.find((snapshot) => snapshot.customEntries.length === 1);
		expect(firstCompleted?.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(firstCompleted?.toolExecutions).toMatchObject([
			{
				toolCallId: "call-1",
				result: { content: [{ type: "text", text: "done" }], isError: false },
				isPartial: false,
			},
		]);
		expect(firstCompleted?.customEntries.map((entry) => entry.customType)).toEqual(["progress-card"]);
		expect(snapshots.every((snapshot) => snapshot.options.expanded)).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.customEntries.length === 1 && !snapshot.isStreaming)).toBe(true);
		expect(snapshots.at(-1)?.isStreaming).toBe(false);
		expect(fakeThis.addCustomEntryToChat).not.toHaveBeenCalled();
	});

	test("excludes custom entries whose registered renderer produces no content", () => {
		const prototype = InteractiveMode.prototype as any;
		const ensureTranscriptTurnComponent = vi.fn();
		const entry = {
			type: "custom",
			id: "state-only",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "state-only",
			data: { private: true },
		};
		const fakeThis: any = {
			getTranscriptTurnRenderer: () => () => undefined,
			session: { extensionRunner: { getEntryRenderer: () => () => undefined } },
			toolOutputExpanded: false,
			ensureTranscriptTurnComponent,
			transcriptCustomEntries: [],
		};

		expect(prototype.appendTranscriptCustomEntry.call(fakeThis, entry)).toBe(false);
		expect(ensureTranscriptTurnComponent).not.toHaveBeenCalled();
		expect(fakeThis.transcriptCustomEntries).toEqual([]);
	});

	test("adds an aborted display label without mutating the persisted assistant message", () => {
		const prototype = InteractiveMode.prototype as any;
		const updateTranscriptAssistant = vi.fn<(value: { errorMessage?: string }) => boolean>(() => true);
		const message: any = {
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "aborted",
			timestamp: 1,
		};
		const fakeThis: any = {
			transcriptTurnComponent: {},
			session: { retryAttempt: 2 },
			updateTranscriptAssistant,
		};

		expect(prototype.finishTranscriptAssistant.call(fakeThis, message)).toBe(true);
		expect(message.errorMessage).toBeUndefined();
		const displayed = updateTranscriptAssistant.mock.calls[0]?.[0];
		if (!displayed) throw new Error("Expected a display-only assistant message");
		expect(displayed).not.toBe(message);
		expect(displayed.errorMessage).toBe("Aborted after 2 retry attempts");
	});

	test.each(["aborted", "error"] as const)("reconciles omitted %s assistant tool calls", (stopReason) => {
		const prototype = InteractiveMode.prototype as any;
		const toolExecutions = new Map();
		const updateTranscriptTurn = vi.fn(() => true);
		const fakeThis: any = {
			transcriptTurnComponent: {},
			transcriptTurnMessages: [],
			transcriptToolExecutions: toolExecutions,
			transcriptAssistantIndex: undefined,
			transcriptTurnStreaming: true,
			ensureTranscriptTurnComponent: () => ({}),
			updateTranscriptTurn,
			reconcileTranscriptToolCalls: prototype.reconcileTranscriptToolCalls,
		};
		const pendingMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "never-started", name: "bash", arguments: { command: "pwd" } }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
			stopReason: "pending",
			timestamp: 0,
		} as unknown as AssistantMessage;
		const terminalMessage = { ...pendingMessage, content: [], stopReason } as AssistantMessage;

		expect(prototype.startTranscriptAssistant.call(fakeThis, pendingMessage)).toBe(true);
		toolExecutions.set("retained", {
			toolCallId: "retained",
			toolName: "read",
			args: { path: "README.md" },
			result: { content: [{ type: "text", text: "retained result" }], isError: false },
			isPartial: true,
		});
		expect(prototype.updateTranscriptAssistant.call(fakeThis, terminalMessage)).toBe(true);
		expect([...toolExecutions.values()]).toMatchObject([
			{
				toolCallId: "never-started",
				toolName: "bash",
				args: { command: "pwd" },
				isPartial: false,
			},
			{
				toolCallId: "retained",
				toolName: "read",
				args: { path: "README.md" },
				result: { content: [{ type: "text", text: "retained result" }], isError: false },
				isPartial: false,
			},
		]);
		expect(updateTranscriptTurn).toHaveBeenCalledTimes(2);
	});

	test.each([
		["aborted", "Aborted fallback"],
		["error", "Error fallback"],
	] as const)(
		"stock fallback renders retained omitted executions after %s terminal content",
		(stopReason, errorMessage) => {
			const prototype = InteractiveMode.prototype as any;
			const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
			try {
				const fallbackContext: any = {
					hideThinkingBlock: false,
					hiddenThinkingLabel: "Thinking...",
					getMarkdownThemeWithSettings: () => ({}),
					settingsManager: { getImageWidthCells: () => 80 },
					getRegisteredToolDefinition: () => undefined,
					ui: { requestRender() {} },
					sessionManager: { getCwd: () => process.cwd() },
					session: { extensionRunner: { getEntryRenderer: () => undefined } },
				};
				const executions = new Map<string, TranscriptToolExecutionSource>([
					["pending", { toolCallId: "pending", toolName: "bash", args: { command: "pwd" }, isPartial: false }],
					[
						"result",
						{
							toolCallId: "result",
							toolName: "edit",
							args: { path: "README.md" },
							result: {
								content: [{ type: "text" as const, text: "retained output" }],
								details: { diff: "retained details" },
								isError: false,
							},
							isPartial: false,
						},
					],
				]);
				const component = new TranscriptTurnComponent(
					() => {
						throw new Error("renderer failure");
					},
					1,
					false,
					80,
					{ requestRender() {} } as never,
					false,
					prototype.renderDefaultTranscriptTurn.bind(fallbackContext),
				);
				component.update({
					messages: [
						{
							role: "assistant",
							content: [],
							api: "test",
							provider: "test",
							model: "test",
							usage: {},
							stopReason,
							errorMessage,
							timestamp: 0,
						},
					] as never,
					customEntries: [],
					toolExecutions: executions,
					isStreaming: false,
				});
				const rendered = stripAnsi(component.render(100).join("\n"));
				expect(rendered).toContain(errorMessage);
				expect(rendered).toContain("retained details");
				expect(updateResult).toHaveBeenCalledWith(
					expect.objectContaining({
						details: { diff: "retained details" },
						content: [{ type: "text", text: "retained output" }],
					}),
					false,
				);
			} finally {
				updateResult.mockRestore();
			}
		},
	);

	test("exports transcript messages without user or tool-result variants", () => {
		expectTypeOf<Extract<TranscriptTurnMessage, { role: "user" | "toolResult" }>>().toEqualTypeOf<never>();
	});

	test("reset detaches every direct transcript surface while retaining other chat children", () => {
		const prototype = InteractiveMode.prototype as any;
		const chatContainer = new Container();
		const turnOne = new TranscriptTurnComponent(() => new Text("one", 0, 0), 1, false, 80, {
			requestRender() {},
		} as never);
		const turnTwo = new TranscriptTurnComponent(() => new Text("two", 0, 0), 1, false, 80, {
			requestRender() {},
		} as never);
		const nonTurn = new Text("keep", 0, 0);
		chatContainer.addChild(turnOne);
		chatContainer.addChild(nonTurn);
		chatContainer.addChild(turnTwo);
		const fakeThis: any = {
			chatContainer,
			transcriptTurnComponent: turnTwo,
			transcriptTurnMessages: [{}],
			transcriptCustomEntries: [{}],
			transcriptToolExecutions: new Map([["tool", {}]]),
			transcriptAssistantIndex: 0,
			transcriptTurnStreaming: false,
			clearTranscriptTurn: prototype.clearTranscriptTurn,
		};
		prototype.detachTranscriptTurns.call(fakeThis);
		expect(chatContainer.children).toEqual([nonTurn]);
		expect(fakeThis.transcriptTurnComponent).toBeUndefined();
		expect(turnOne.render(80)).toEqual([]);
		expect(turnTwo.render(80)).toEqual([]);
	});

	test("renderer changes rebuild through session items and deactivate prior turn components", async () => {
		const prototype = InteractiveMode.prototype as any;
		const chatContainer = new Container();
		const priorTurn = new TranscriptTurnComponent(() => new Text("summary", 0, 0), 1, false, 80, {
			requestRender() {},
		} as never);
		chatContainer.addChild(priorTurn);
		let bindings: { onTranscriptTurnRendererChange?: () => void } | undefined;
		const items = [{ role: "user", content: "existing", timestamp: 1 }];
		const renderSessionEntries = vi.fn();
		const fakeThis: any = {
			chatContainer,
			transcriptTurnComponent: priorTurn,
			transcriptTurnMessages: [],
			transcriptCustomEntries: [],
			transcriptToolExecutions: new Map(),
			transcriptAssistantIndex: undefined,
			transcriptTurnStreaming: false,
			clearTranscriptTurn: vi.fn(),
			clearChatContainer: prototype.clearChatContainer,
			rebuildChatFromMessages: prototype.rebuildChatFromMessages,
			sessionManager: { buildContextEntries: () => items },
			renderSessionEntries,
			createExtensionUIContext: () => ({}),
			session: {
				bindExtensions: async (value: { onTranscriptTurnRendererChange?: () => void }) => {
					bindings = value;
				},
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
			},
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			showLoadedResources: vi.fn(),
			showStartupNoticesIfNeeded: vi.fn(),
		};

		await prototype.bindCurrentSessionExtensions.call(fakeThis);
		expect(bindings?.onTranscriptTurnRendererChange).toBeDefined();
		bindings?.onTranscriptTurnRendererChange?.();
		expect(chatContainer.children).toEqual([]);
		expect(priorTurn.render(80)).toEqual([]);
		expect(renderSessionEntries).toHaveBeenCalledTimes(1);
		expect(renderSessionEntries).toHaveBeenCalledWith(items);
	});

	test("normal chat clears deactivate pending image conversions", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		let resolveConversion: (value: { data: string; mimeType: string } | undefined) => void = () => {};
		imageConversion.convertToPng.mockReturnValue(
			new Promise((resolve) => {
				resolveConversion = resolve;
			}),
		);
		const renderer = vi.fn(() => new Text("turn", 0, 0));
		const requestRender = vi.fn();
		const transcript = new TranscriptTurnComponent(renderer, 1, true, 80, { requestRender } as never);
		transcript.update({
			messages: [],
			customEntries: [],
			toolExecutions: [
				{
					toolCallId: "image",
					toolName: "read",
					args: {},
					result: { content: [{ type: "image", data: "jpeg", mimeType: "image/jpeg" }], isError: false },
					isPartial: false,
				},
			],
			isStreaming: false,
		});
		transcript.render(80);
		const chatContainer = new Container();
		chatContainer.addChild(transcript);
		const prototype = InteractiveMode.prototype as any;
		const fakeThis: any = {
			chatContainer,
			transcriptTurnComponent: transcript,
			transcriptTurnMessages: [],
			transcriptCustomEntries: [],
			transcriptToolExecutions: new Map(),
			transcriptAssistantIndex: undefined,
			transcriptTurnStreaming: false,
			clearTranscriptTurn: prototype.clearTranscriptTurn,
		};
		prototype.clearChatContainer.call(fakeThis);
		resolveConversion({ data: "png", mimeType: "image/png" });
		await Promise.resolve();
		expect(chatContainer.children).toEqual([]);
		expect(renderer).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledOnce();
	});

	test("rotates tool execution maps while completed turns retain their ordered source", () => {
		const prototype = InteractiveMode.prototype as any;
		const executions = new Map([
			["first", { toolCallId: "first", toolName: "bash", args: { command: "pwd" }, isPartial: false }],
			[
				"second",
				{
					toolCallId: "second",
					toolName: "read",
					args: { path: "README.md" },
					result: { content: [{ type: "text", text: "done" }], isError: false },
					isPartial: false,
				},
			],
		]);
		const updates: Array<{ toolExecutions: unknown }> = [];
		const fakeThis: any = {
			transcriptTurnComponent: { update: (turn: { toolExecutions: unknown }) => updates.push(turn) },
			transcriptTurnMessages: [],
			transcriptCustomEntries: [],
			transcriptToolExecutions: executions,
			transcriptAssistantIndex: undefined,
			transcriptTurnStreaming: false,
			clearTranscriptTurn: prototype.clearTranscriptTurn,
		};
		expect(prototype.updateTranscriptTurn.call(fakeThis)).toBe(true);
		expect(updates[0]?.toolExecutions).toBe(executions);
		prototype.clearTranscriptTurn.call(fakeThis);
		expect(fakeThis.transcriptToolExecutions).not.toBe(executions);
		expect([...executions.values()]).toMatchObject([
			{ toolCallId: "first", args: { command: "pwd" } },
			{ toolCallId: "second", result: { content: [{ type: "text", text: "done" }], isError: false } },
		]);
		expect(fakeThis.transcriptToolExecutions.size).toBe(0);
	});

	test("settles before clearing a user boundary but clear itself never updates stale components", () => {
		const prototype = InteractiveMode.prototype as any;
		const update = vi.fn();
		const fakeThis: any = {
			transcriptTurnComponent: { update },
			transcriptTurnMessages: [{}],
			transcriptCustomEntries: [{}],
			transcriptToolExecutions: new Map([["call", {}]]),
			transcriptAssistantIndex: 0,
			transcriptTurnStreaming: true,
			setTranscriptTurnStreaming: prototype.setTranscriptTurnStreaming,
			updateTranscriptTurn: () => {
				update();
				return true;
			},
			clearTranscriptTurn: prototype.clearTranscriptTurn,
		};
		prototype.settleAndClearTranscriptTurn.call(fakeThis);
		expect(update).toHaveBeenCalledOnce();
		expect(fakeThis.transcriptTurnComponent).toBeUndefined();
		prototype.clearTranscriptTurn.call({ ...fakeThis, transcriptTurnComponent: { update } });
		expect(update).toHaveBeenCalledOnce();
	});

	test("suppresses the duplicate working indicator while a turn renderer owns progress", async () => {
		const prototype = InteractiveMode.prototype as any;
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			pendingTools: new Map(),
			setTranscriptTurnStreaming: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			retryEscapeHandler: undefined,
			getTranscriptTurnRenderer: () => () => undefined,
			workingVisible: true,
			showStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
		};

		await prototype.handleEvent.call(fakeThis, { type: "agent_start" });

		expect(fakeThis.clearStatusIndicator).toHaveBeenCalled();
		expect(fakeThis.showStatusIndicator).not.toHaveBeenCalled();
	});

	test("keeps retrying turns streaming until the final agent end or settlement", async () => {
		const prototype = InteractiveMode.prototype as any;
		const setTranscriptTurnStreaming = vi.fn();
		const fakeThis: any = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			setTranscriptTurnStreaming,
			clearStatusIndicator: vi.fn(),
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			checkShutdownRequested: vi.fn(async () => {}),
		};

		await prototype.handleEvent.call(fakeThis, { type: "agent_end", messages: [], willRetry: true });
		expect(setTranscriptTurnStreaming).not.toHaveBeenCalledWith(false);
		await prototype.handleEvent.call(fakeThis, { type: "agent_end", messages: [], willRetry: false });
		expect(setTranscriptTurnStreaming).toHaveBeenCalledWith(false);
		setTranscriptTurnStreaming.mockClear();
		await prototype.handleEvent.call(fakeThis, { type: "agent_settled" });
		expect(setTranscriptTurnStreaming).toHaveBeenCalledWith(false);
	});
});
