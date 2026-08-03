import type { Component } from "@earendil-works/pi-tui";
import { Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type {
	TranscriptToolExecution,
	TranscriptTurn,
	TranscriptTurnRenderer,
} from "../../../core/extensions/types.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type Theme, theme } from "../theme/theme.ts";

const MAX_ESTIMATED_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ESTIMATED_SNAPSHOT_WORK_UNITS = 100_000;
const MAX_SNAPSHOT_DEPTH = 256;
const OBJECT_COST = 32;
const PROPERTY_COST = 16;
const MAP_ENTRY_COST = 48;
const SET_ENTRY_COST = 32;

type TranscriptToolResultSource = NonNullable<TranscriptToolExecution["result"]> & {
	details?: unknown;
	usage?: unknown;
	addedToolNames?: string[];
	terminate?: boolean;
};

export type TranscriptToolExecutionSource = Omit<TranscriptToolExecution, "result"> & {
	result?: TranscriptToolResultSource;
};

export type TranscriptToolExecutionsSource =
	| readonly TranscriptToolExecutionSource[]
	| ReadonlyMap<string, TranscriptToolExecutionSource>;

export type TranscriptTurnSource = Omit<TranscriptTurn, "toolExecutions"> & {
	toolExecutions: TranscriptToolExecutionsSource;
};

function isTranscriptToolExecutionMap(
	executions: TranscriptToolExecutionsSource,
): executions is ReadonlyMap<string, TranscriptToolExecutionSource> {
	return executions instanceof Map;
}

function* transcriptToolExecutionArrayValues(
	executions: readonly TranscriptToolExecutionSource[],
): Generator<TranscriptToolExecutionSource> {
	try {
		const length = getArrayLength(executions);
		if (length === undefined) return;
		for (let index = 0; index < length; index += 1) {
			try {
				const descriptor = Object.getOwnPropertyDescriptor(executions, String(index));
				if (!descriptor || !("value" in descriptor)) continue;
				const execution = descriptor.value;
				if (execution && typeof execution === "object") yield execution as TranscriptToolExecutionSource;
			} catch {}
		}
	} catch {
		return;
	}
}

export function transcriptToolExecutionValues(
	executions: TranscriptToolExecutionsSource,
): Iterable<TranscriptToolExecutionSource> {
	return isTranscriptToolExecutionMap(executions)
		? (Map.prototype.values.call(executions) as IterableIterator<TranscriptToolExecutionSource>)
		: transcriptToolExecutionArrayValues(executions);
}

export function getTranscriptToolExecution(
	executions: TranscriptToolExecutionsSource,
	toolCallId: string,
): TranscriptToolExecutionSource | undefined {
	if (isTranscriptToolExecutionMap(executions)) {
		return Map.prototype.get.call(executions, toolCallId) as TranscriptToolExecutionSource | undefined;
	}
	for (const execution of transcriptToolExecutionArrayValues(executions)) {
		if (execution.toolCallId === toolCallId) return execution;
	}
	return undefined;
}

type TranscriptTurnFallbackRenderer = (
	turn: TranscriptTurnSource,
	options: { expanded: boolean; outputPad: number; showImages: boolean },
	theme: Theme,
) => Component | undefined;

type ConvertedImage = {
	sourceData: string;
	sourceMimeType: string;
	data: string;
	mimeType: string;
};

type ImageConversion = {
	sourceData: string;
	sourceMimeType: string;
	status: "pending" | "failed";
};

type CachedImageComponent = {
	data: string;
	mimeType: string;
	maxWidthCells: number;
	component: Image;
};

type SnapshotBudget = {
	bytes: number;
	work: number;
	seen: WeakSet<object>;
	countedBuffers: WeakSet<object>;
};

type SnapshotTask = { value: unknown; depth: number };

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")?.get;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const regexpFlagsGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get;

function isSharedBuffer(value: unknown): boolean {
	return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function getArrayBufferByteLength(value: ArrayBuffer): number | undefined {
	const byteLength = arrayBufferByteLengthGetter?.call(value);
	return typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength >= 0
		? byteLength
		: undefined;
}

function getViewBuffer(value: ArrayBufferView): ArrayBuffer | SharedArrayBuffer | undefined {
	const buffer = (value instanceof DataView ? dataViewBufferGetter : typedArrayBufferGetter)?.call(value);
	return buffer instanceof ArrayBuffer || isSharedBuffer(buffer) ? buffer : undefined;
}

function getOwnData(value: object, key: string): unknown | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new Error("Snapshot property is unavailable");
	return descriptor.value;
}

function getOptionalOwnData(value: object, key: string): unknown | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor) return undefined;
	if (!("value" in descriptor)) throw new Error("Snapshot property is unavailable");
	return descriptor.value;
}

function getArrayLength(value: object): number | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
		return undefined;
	}
	return descriptor.value;
}

function addBytes(budget: SnapshotBudget, bytes: number): boolean {
	budget.bytes += bytes;
	return budget.bytes <= MAX_ESTIMATED_SNAPSHOT_BYTES;
}

function addWork(budget: SnapshotBudget, work = 1): boolean {
	budget.work += work;
	return budget.work <= MAX_ESTIMATED_SNAPSHOT_WORK_UNITS;
}

function getCollectionSize(getter: (() => unknown) | undefined, value: object): number | undefined {
	const size = getter?.call(value);
	return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function estimateSnapshotValues(roots: readonly unknown[], budget: SnapshotBudget): boolean {
	try {
		const stack: SnapshotTask[] = roots.map((value) => ({ value, depth: 0 }));
		if (stack.length > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS) return false;
		while (stack.length > 0) {
			const task = stack.pop();
			if (!task || task.depth > MAX_SNAPSHOT_DEPTH || !addWork(budget)) return false;
			const { value, depth } = task;
			if (typeof value === "string") {
				if (!addBytes(budget, value.length * 2)) return false;
				continue;
			}
			if (
				value === null ||
				typeof value === "undefined" ||
				typeof value === "boolean" ||
				typeof value === "number"
			) {
				continue;
			}
			if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return false;
			if (typeof value !== "object" || budget.seen.has(value)) continue;
			budget.seen.add(value);
			if (!addBytes(budget, OBJECT_COST)) return false;

			if (value instanceof ArrayBuffer) {
				const byteLength = getArrayBufferByteLength(value);
				if (byteLength === undefined) return false;
				if (!budget.countedBuffers.has(value)) {
					budget.countedBuffers.add(value);
					if (!addBytes(budget, byteLength)) return false;
				}
				continue;
			}
			if (ArrayBuffer.isView(value)) {
				const buffer = getViewBuffer(value);
				if (!buffer || isSharedBuffer(buffer) || !(buffer instanceof ArrayBuffer)) return false;
				const byteLength = getArrayBufferByteLength(buffer);
				if (byteLength === undefined) return false;
				if (!budget.countedBuffers.has(buffer)) {
					budget.countedBuffers.add(buffer);
					if (!addBytes(budget, byteLength)) return false;
				}
				continue;
			}
			if (isSharedBuffer(value)) return false;
			if (value instanceof Date) {
				if (!addBytes(budget, 8)) return false;
				continue;
			}
			if (value instanceof RegExp) {
				const source = regexpSourceGetter?.call(value);
				const flags = regexpFlagsGetter?.call(value);
				if (
					typeof source !== "string" ||
					typeof flags !== "string" ||
					!addBytes(budget, (source.length + flags.length) * 2)
				) {
					return false;
				}
				continue;
			}
			if (value instanceof Map) {
				const size = getCollectionSize(mapSizeGetter, value);
				if (
					size === undefined ||
					size * 2 > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS - budget.work ||
					stack.length + size * 2 > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS ||
					!addBytes(budget, size * MAP_ENTRY_COST)
				) {
					return false;
				}
				for (const [key, entry] of Map.prototype.entries.call(value)) {
					if (!addWork(budget, 2) || stack.length + 2 > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS) return false;
					stack.push({ value: key, depth: depth + 1 }, { value: entry, depth: depth + 1 });
				}
				continue;
			}
			if (value instanceof Set) {
				const size = getCollectionSize(setSizeGetter, value);
				if (
					size === undefined ||
					size > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS - budget.work ||
					stack.length + size > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS ||
					!addBytes(budget, size * SET_ENTRY_COST)
				) {
					return false;
				}
				for (const entry of Set.prototype.values.call(value)) {
					if (!addWork(budget) || stack.length + 1 > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS) return false;
					stack.push({ value: entry, depth: depth + 1 });
				}
				continue;
			}
			if (Array.isArray(value)) {
				const length = getArrayLength(value);
				if (length === undefined || length > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS - budget.work) return false;
			} else {
				const prototype = Object.getPrototypeOf(value);
				if (prototype !== Object.prototype && prototype !== null) return false;
			}
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
				if (
					!addWork(budget) ||
					!addBytes(budget, PROPERTY_COST + key.length * 2) ||
					stack.length + 1 > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS
				) {
					return false;
				}
				stack.push({ value: descriptor.value, depth: depth + 1 });
			}
		}
		return true;
	} catch {
		return false;
	}
}

function estimateTranscriptExecution(execution: unknown, budget: SnapshotBudget): boolean {
	if (!execution || typeof execution !== "object") return false;
	const toolCallId = getOwnData(execution, "toolCallId");
	const toolName = getOwnData(execution, "toolName");
	const args = getOwnData(execution, "args");
	const result = getOptionalOwnData(execution, "result");
	const isPartial = getOwnData(execution, "isPartial");
	if (typeof toolCallId !== "string" || typeof toolName !== "string" || typeof isPartial !== "boolean") return false;
	const roots: unknown[] = [toolCallId, toolName, args, isPartial];
	if (result !== undefined) {
		if (!result || typeof result !== "object") return false;
		const content = getOwnData(result, "content");
		const isError = getOwnData(result, "isError");
		if (!Array.isArray(content) || typeof isError !== "boolean") return false;
		roots.push(content, isError);
	}
	return estimateSnapshotValues(roots, budget);
}

function createPublicTranscriptExecution(execution: object): TranscriptToolExecution {
	const result = getOptionalOwnData(execution, "result");
	return {
		toolCallId: getOwnData(execution, "toolCallId") as string,
		toolName: getOwnData(execution, "toolName") as string,
		args: getOwnData(execution, "args"),
		result:
			result === undefined
				? undefined
				: {
						content: getOwnData(result as object, "content") as NonNullable<
							TranscriptToolExecution["result"]
						>["content"],
						isError: getOwnData(result as object, "isError") as boolean,
					},
		isPartial: getOwnData(execution, "isPartial") as boolean,
	};
}

function createSnapshot(turn: TranscriptTurnSource): TranscriptTurn | undefined {
	try {
		const messages = getOwnData(turn, "messages");
		const customEntries = getOwnData(turn, "customEntries");
		const toolExecutions = getOwnData(turn, "toolExecutions");
		const isStreaming = getOwnData(turn, "isStreaming");
		if (
			!Array.isArray(messages) ||
			!Array.isArray(customEntries) ||
			(!Array.isArray(toolExecutions) && !(toolExecutions instanceof Map)) ||
			typeof isStreaming !== "boolean"
		) {
			return undefined;
		}
		const executionLength = Array.isArray(toolExecutions)
			? getArrayLength(toolExecutions)
			: getCollectionSize(mapSizeGetter, toolExecutions);
		if (executionLength === undefined || executionLength > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS) return undefined;
		const budget: SnapshotBudget = {
			bytes: 0,
			work: 0,
			seen: new WeakSet(),
			countedBuffers: new WeakSet(),
		};
		if (!estimateSnapshotValues([messages, customEntries, isStreaming], budget)) return undefined;
		if (executionLength > MAX_ESTIMATED_SNAPSHOT_WORK_UNITS - budget.work) return undefined;
		if (Array.isArray(toolExecutions)) {
			for (let index = 0; index < executionLength; index += 1) {
				if (!estimateTranscriptExecution(getOwnData(toolExecutions, String(index)), budget)) return undefined;
			}
		} else {
			for (const execution of Map.prototype.values.call(
				toolExecutions,
			) as IterableIterator<TranscriptToolExecutionSource>) {
				if (!estimateTranscriptExecution(execution, budget)) return undefined;
			}
		}
		const publicExecutions: TranscriptToolExecution[] = [];
		if (Array.isArray(toolExecutions)) {
			for (let index = 0; index < executionLength; index += 1) {
				publicExecutions.push(createPublicTranscriptExecution(getOwnData(toolExecutions, String(index)) as object));
			}
		} else {
			for (const execution of Map.prototype.values.call(
				toolExecutions,
			) as IterableIterator<TranscriptToolExecutionSource>) {
				publicExecutions.push(createPublicTranscriptExecution(execution));
			}
		}
		return structuredClone({
			messages: messages as TranscriptTurn["messages"],
			customEntries: customEntries as TranscriptTurn["customEntries"],
			toolExecutions: publicExecutions,
			isStreaming,
		} satisfies TranscriptTurn);
	} catch {
		return undefined;
	}
}

function isCanonicalArrayIndex(key: string): boolean {
	if (!/^(0|[1-9]\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index < 2 ** 32 - 1;
}

function getResultContent(result: unknown): object | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = getOwnData(result, "content");
	return Array.isArray(content) ? content : undefined;
}

export function getTranscriptToolResultTextContent(result: unknown): Array<{ type: "text"; text: string }> {
	try {
		const content = getResultContent(result);
		if (!content) return [];
		const text: Array<{ type: "text"; text: string }> = [];
		for (const key in content) {
			if (!isCanonicalArrayIndex(key) || !Object.hasOwn(content, key)) continue;
			try {
				const descriptor = Object.getOwnPropertyDescriptor(content, key);
				if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) continue;
				const item = descriptor.value;
				if (!item || typeof item !== "object" || getOwnData(item, "type") !== "text") continue;
				const value = getOwnData(item, "text");
				if (typeof value === "string") text.push({ type: "text", text: value });
			} catch {}
		}
		return text;
	} catch {
		return [];
	}
}

type NativeImageRecord = { key: string; data: string; mimeType: string };

function collectNativeImages(executions: TranscriptToolExecutionsSource): NativeImageRecord[] {
	const images: NativeImageRecord[] = [];
	try {
		for (const execution of transcriptToolExecutionValues(executions)) {
			try {
				const toolCallId = getOwnData(execution, "toolCallId");
				const content = getResultContent(getOptionalOwnData(execution, "result"));
				if (typeof toolCallId !== "string" || !content) continue;
				for (const index in content) {
					if (!isCanonicalArrayIndex(index) || !Object.hasOwn(content, index)) continue;
					try {
						const descriptor = Object.getOwnPropertyDescriptor(content, index);
						if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) continue;
						const item = descriptor.value;
						if (!item || typeof item !== "object" || getOwnData(item, "type") !== "image") continue;
						const data = getOwnData(item, "data");
						const mimeType = getOwnData(item, "mimeType");
						if (typeof data === "string" && typeof mimeType === "string" && data && mimeType) {
							images.push({ key: `${toolCallId}:${index}`, data, mimeType });
						}
					} catch {}
				}
			} catch {}
		}
	} catch {
		return images;
	}
	return images;
}

/**
 * Host-owned shell for an extension-rendered transcript turn. It deliberately
 * keeps images outside extension output so terminal image protocols remain
 * owned by Pi's Image component.
 */
export class TranscriptTurnComponent extends Container {
	private sourceTurn: TranscriptTurnSource = {
		messages: [],
		customEntries: [],
		toolExecutions: [],
		isStreaming: true,
	};
	private rendererTurn: TranscriptTurn | undefined;
	private snapshotFailed = false;
	private snapshotDirty = true;
	private renderDirty = false;
	private revision = 0;
	private active = true;
	private expanded = false;
	private readonly renderer: TranscriptTurnRenderer;
	private readonly fallbackRenderer: TranscriptTurnFallbackRenderer | undefined;
	private outputPad: number;
	private showImages: boolean;
	private imageWidthCells: number;
	private readonly ui: TUI;
	private readonly convertedImages = new Map<string, ConvertedImage>();
	private readonly imageConversions = new Map<string, ImageConversion>();
	private readonly imageComponents = new Map<string, CachedImageComponent>();

	constructor(
		renderer: TranscriptTurnRenderer,
		outputPad: number,
		showImages: boolean,
		imageWidthCells: number,
		ui: TUI,
		expanded = false,
		fallbackRenderer?: TranscriptTurnFallbackRenderer,
	) {
		super();
		this.renderer = renderer;
		this.fallbackRenderer = fallbackRenderer;
		this.outputPad = outputPad;
		this.showImages = showImages;
		this.imageWidthCells = imageWidthCells;
		this.ui = ui;
		this.expanded = expanded;
	}

	update(turn: TranscriptTurnSource): void {
		if (!this.active) return;
		this.sourceTurn = turn;
		this.markDirty(true);
	}

	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		this.clear();
		this.rendererTurn = undefined;
		this.snapshotDirty = false;
		this.renderDirty = false;
		this.convertedImages.clear();
		this.imageConversions.clear();
		this.imageComponents.clear();
	}

	setExpanded(expanded: boolean): void {
		if (!this.active || this.expanded === expanded) return;
		this.expanded = expanded;
		this.markDirty();
	}

	setOutputPad(outputPad: number): void {
		if (!this.active || this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.markDirty();
	}

	setShowImages(showImages: boolean): void {
		if (!this.active || this.showImages === showImages) return;
		this.showImages = showImages;
		this.markDirty();
	}

	setImageWidthCells(imageWidthCells: number): void {
		const nextWidth = Math.max(1, Math.floor(imageWidthCells));
		if (!this.active || this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.imageComponents.clear();
		this.markDirty();
	}

	override invalidate(): void {
		if (!this.active) return;
		super.invalidate();
		for (const image of this.imageComponents.values()) image.component.invalidate();
		this.markDirty();
	}

	override render(width: number): string[] {
		if (!this.active) return [];
		if (this.renderDirty) this.rebuild();
		return super.render(width);
	}

	private markDirty(snapshotChanged = false): void {
		if (!this.active) return;
		this.revision += 1;
		if (snapshotChanged) this.snapshotDirty = true;
		if (this.renderDirty) return;
		this.renderDirty = true;
		this.ui.requestRender();
	}

	private rebuild(): void {
		if (!this.active) return;
		const sourceTurn = this.sourceTurn;
		const revision = this.revision;
		const snapshotDirty = this.snapshotDirty;
		this.renderDirty = false;
		this.snapshotDirty = false;
		if (snapshotDirty) {
			this.rendererTurn = createSnapshot(sourceTurn);
			this.snapshotFailed = this.rendererTurn === undefined;
		}
		this.clear();
		if (!this.active) return;
		const options = { expanded: this.expanded, outputPad: this.outputPad, showImages: this.showImages };
		let component: Component | undefined;
		if (this.snapshotFailed) {
			component = this.createFallback(
				sourceTurn,
				options,
				"Transcript turn renderer input could not be snapshotted; using Pi's default turn rendering.",
			);
		} else {
			try {
				component = this.renderer(this.rendererTurn as TranscriptTurn, options, theme);
			} catch {
				component = this.createFallback(
					sourceTurn,
					options,
					"Transcript turn renderer failed; using Pi's default turn rendering.",
				);
			}
		}
		if (!this.active || this.revision !== revision || this.renderDirty) return;
		if (component) this.addChild(component);
		this.rebuildImages(sourceTurn);
	}

	private createFallback(
		turn: TranscriptTurnSource,
		options: { expanded: boolean; outputPad: number; showImages: boolean },
		message: string,
	): Component {
		const fallback = new Container();
		fallback.addChild(new Text(theme.fg("error", message), 0, 0));
		try {
			if (!this.active) return fallback;
			const stockComponent = this.fallbackRenderer?.(turn, options, theme);
			if (this.active && stockComponent) fallback.addChild(stockComponent);
		} catch {
			if (this.active) fallback.addChild(new Text(theme.fg("error", "Pi could not render this turn."), 0, 0));
		}
		return fallback;
	}

	private rebuildImages(sourceTurn: TranscriptTurnSource): void {
		if (!this.active) return;
		const capabilities = getCapabilities();
		if (!this.showImages || !capabilities.images) return;
		const images = collectNativeImages(sourceTurn.toolExecutions);
		const activeKeys = new Set(images.map((image) => image.key));
		for (const key of this.convertedImages.keys()) {
			if (!activeKeys.has(key)) this.convertedImages.delete(key);
		}
		for (const key of this.imageConversions.keys()) {
			if (!activeKeys.has(key)) this.imageConversions.delete(key);
		}
		for (const key of this.imageComponents.keys()) {
			if (!activeKeys.has(key)) this.imageComponents.delete(key);
		}

		for (const imageRecord of images) {
			const converted = this.convertedImages.get(imageRecord.key);
			const matchesSource =
				converted?.sourceData === imageRecord.data && converted.sourceMimeType === imageRecord.mimeType;
			const image = matchesSource ? converted : imageRecord;
			if (capabilities.images === "kitty" && image.mimeType !== "image/png") {
				this.convertImageForKitty(imageRecord.key, imageRecord.data, imageRecord.mimeType);
				continue;
			}
			let cached = this.imageComponents.get(imageRecord.key);
			if (
				!cached ||
				cached.data !== image.data ||
				cached.mimeType !== image.mimeType ||
				cached.maxWidthCells !== this.imageWidthCells
			) {
				cached = {
					data: image.data,
					mimeType: image.mimeType,
					maxWidthCells: this.imageWidthCells,
					component: new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (text) => theme.fg("muted", text) },
						{ maxWidthCells: this.imageWidthCells },
					),
				};
				this.imageComponents.set(imageRecord.key, cached);
			}
			this.addChild(new Spacer(1));
			this.addChild(cached.component);
		}
	}

	private convertImageForKitty(key: string, data: string, mimeType: string): void {
		if (!this.active) return;
		const current = this.imageConversions.get(key);
		if (current?.sourceData === data && current.sourceMimeType === mimeType) return;
		this.imageConversions.set(key, { sourceData: data, sourceMimeType: mimeType, status: "pending" });
		void convertToPng(data, mimeType).then(
			(converted) => {
				if (!this.active) return;
				const latest = this.imageConversions.get(key);
				if (latest?.sourceData !== data || latest.sourceMimeType !== mimeType) return;
				if (converted) {
					this.convertedImages.set(key, {
						sourceData: data,
						sourceMimeType: mimeType,
						data: converted.data,
						mimeType: converted.mimeType,
					});
					this.imageConversions.delete(key);
					this.imageComponents.delete(key);
					this.markDirty();
				} else {
					latest.status = "failed";
				}
			},
			() => {
				if (!this.active) return;
				const latest = this.imageConversions.get(key);
				if (latest?.sourceData === data && latest.sourceMimeType === mimeType) latest.status = "failed";
			},
		);
	}
}
