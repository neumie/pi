import type { Component } from "@earendil-works/pi-tui";
import { Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type {
	TranscriptToolExecution,
	TranscriptTurn,
	TranscriptTurnRenderer,
} from "../../../core/extensions/types.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type Theme, theme } from "../theme/theme.ts";

type TranscriptToolResultSource = NonNullable<TranscriptToolExecution["result"]> & {
	details?: unknown;
	usage?: unknown;
	addedToolNames?: string[];
	terminate?: boolean;
};

export type TranscriptToolExecutionSource = Omit<TranscriptToolExecution, "result"> & {
	result?: TranscriptToolResultSource;
};

export type TranscriptTurnSource = Omit<TranscriptTurn, "toolExecutions"> & {
	toolExecutions: readonly TranscriptToolExecutionSource[];
};

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
		this.sourceTurn = turn;
		try {
			this.rendererTurn = structuredClone({
				messages: turn.messages,
				customEntries: turn.customEntries,
				toolExecutions: turn.toolExecutions.map((execution) => ({
					toolCallId: execution.toolCallId,
					toolName: execution.toolName,
					args: execution.args,
					result: execution.result
						? { content: execution.result.content, isError: execution.result.isError }
						: undefined,
					isPartial: execution.isPartial,
				})),
				isStreaming: turn.isStreaming,
			} satisfies TranscriptTurn);
			this.snapshotFailed = false;
		} catch {
			this.rendererTurn = undefined;
			this.snapshotFailed = true;
		}
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setShowImages(showImages: boolean): void {
		if (this.showImages === showImages) return;
		this.showImages = showImages;
		this.rebuild();
	}

	setImageWidthCells(imageWidthCells: number): void {
		const nextWidth = Math.max(1, Math.floor(imageWidthCells));
		if (this.imageWidthCells === nextWidth) return;
		this.imageWidthCells = nextWidth;
		this.imageComponents.clear();
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		for (const image of this.imageComponents.values()) image.component.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const options = { expanded: this.expanded, outputPad: this.outputPad, showImages: this.showImages };
		let component: Component | undefined;
		if (this.snapshotFailed) {
			component = this.createFallback(
				options,
				"Transcript turn renderer input could not be snapshotted; using Pi's default turn rendering.",
			);
		} else {
			try {
				component = this.renderer(this.rendererTurn as TranscriptTurn, options, theme);
			} catch {
				component = this.createFallback(
					options,
					"Transcript turn renderer failed; using Pi's default turn rendering.",
				);
			}
		}
		if (component) this.addChild(component);
		this.rebuildImages();
	}

	private createFallback(
		options: { expanded: boolean; outputPad: number; showImages: boolean },
		message: string,
	): Component {
		const fallback = new Container();
		fallback.addChild(new Text(theme.fg("error", message), 0, 0));
		try {
			const stockComponent = this.fallbackRenderer?.(this.sourceTurn, options, theme);
			if (stockComponent) fallback.addChild(stockComponent);
		} catch {
			fallback.addChild(new Text(theme.fg("error", "Pi could not render this turn."), 0, 0));
		}
		return fallback;
	}

	private rebuildImages(): void {
		const activeKeys = new Set<string>();
		for (const execution of this.sourceTurn.toolExecutions) {
			for (const [index, content] of (execution.result?.content ?? []).entries()) {
				if (content.type === "image" && content.data && content.mimeType) {
					activeKeys.add(`${execution.toolCallId}:${index}`);
				}
			}
		}
		for (const key of this.convertedImages.keys()) {
			if (!activeKeys.has(key)) this.convertedImages.delete(key);
		}
		for (const key of this.imageConversions.keys()) {
			if (!activeKeys.has(key)) this.imageConversions.delete(key);
		}
		for (const key of this.imageComponents.keys()) {
			if (!activeKeys.has(key)) this.imageComponents.delete(key);
		}

		const capabilities = getCapabilities();
		if (!this.showImages || !capabilities.images) return;

		for (const execution of this.sourceTurn.toolExecutions) {
			for (const [index, content] of (execution.result?.content ?? []).entries()) {
				if (content.type !== "image" || !content.data || !content.mimeType) continue;
				const key = `${execution.toolCallId}:${index}`;
				const converted = this.convertedImages.get(key);
				const matchesSource =
					converted?.sourceData === content.data && converted.sourceMimeType === content.mimeType;
				const image = matchesSource ? converted : content;
				if (capabilities.images === "kitty" && image.mimeType !== "image/png") {
					this.convertImageForKitty(key, content.data, content.mimeType);
					continue;
				}

				let cached = this.imageComponents.get(key);
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
					this.imageComponents.set(key, cached);
				}
				this.addChild(new Spacer(1));
				this.addChild(cached.component);
			}
		}
	}

	private convertImageForKitty(key: string, data: string, mimeType: string): void {
		const current = this.imageConversions.get(key);
		if (current?.sourceData === data && current.sourceMimeType === mimeType) return;
		this.imageConversions.set(key, { sourceData: data, sourceMimeType: mimeType, status: "pending" });
		void convertToPng(data, mimeType).then(
			(converted) => {
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
					this.rebuild();
					this.ui.requestRender();
				} else {
					latest.status = "failed";
				}
			},
			() => {
				const latest = this.imageConversions.get(key);
				if (latest?.sourceData === data && latest.sourceMimeType === mimeType) latest.status = "failed";
			},
		);
	}
}
