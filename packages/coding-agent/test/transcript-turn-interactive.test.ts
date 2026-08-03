import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { TranscriptTurn, TranscriptTurnRenderOptions } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("InteractiveMode transcript turns", () => {
	beforeAll(() => initTheme("dark"));

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

		expect(chatContainer.children).toHaveLength(4);
		const firstCompleted = snapshots
			.slice()
			.reverse()
			.find((snapshot) => snapshot.customEntries.length === 1);
		expect(firstCompleted?.messages.map((message) => message.role)).toEqual(["custom", "assistant"]);
		expect(firstCompleted?.toolExecutions).toMatchObject([
			{ toolCallId: "call-1", result: { content: [{ type: "text", text: "done" }], isError: false } },
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

	test("reconciles aborted assistant tool calls before tool execution starts", () => {
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
		const abortedMessage = { ...pendingMessage, stopReason: "aborted" } as AssistantMessage;

		expect(prototype.startTranscriptAssistant.call(fakeThis, pendingMessage)).toBe(true);
		expect(toolExecutions.get("never-started")?.isPartial).toBe(true);
		expect(prototype.updateTranscriptAssistant.call(fakeThis, abortedMessage)).toBe(true);
		expect(toolExecutions.get("never-started")).toMatchObject({
			toolName: "bash",
			args: { command: "pwd" },
			isPartial: false,
		});
		expect(updateTranscriptTurn).toHaveBeenCalledTimes(2);
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
