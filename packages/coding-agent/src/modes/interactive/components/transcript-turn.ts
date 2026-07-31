import type { Component } from "@earendil-works/pi-tui";
import { Container, getCapabilities, Image, Spacer, type TUI } from "@earendil-works/pi-tui";
import type {
	TranscriptToolExecution,
	TranscriptTurn,
	TranscriptTurnRenderer,
} from "../../../core/extensions/types.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

/**
 * Host-owned shell for an extension-rendered transcript turn. It deliberately
 * keeps images outside extension output so terminal image protocols remain
 * owned by Pi's Image component.
 */
export class TranscriptTurnComponent extends Container {
	private messages: TranscriptTurn["messages"] = [];
	private toolExecutions: readonly TranscriptToolExecution[] = [];
	private isStreaming = true;
	private expanded = false;
	private readonly renderer: TranscriptTurnRenderer;
	private readonly outputPad: number;
	private readonly showImages: boolean;
	private readonly imageWidthCells: number;
	private readonly ui: TUI;
	private convertedImages = new Map<string, { data: string; mimeType: string }>();

	constructor(renderer: TranscriptTurnRenderer, outputPad: number, showImages: boolean, imageWidthCells: number, ui: TUI) {
		super();
		this.renderer = renderer;
		this.outputPad = outputPad;
		this.showImages = showImages;
		this.imageWidthCells = imageWidthCells;
		this.ui = ui;
	}

	update(turn: TranscriptTurn): void {
		this.messages = turn.messages;
		this.toolExecutions = turn.toolExecutions;
		this.isStreaming = turn.isStreaming;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		let component: Component | undefined;
		try {
			component = this.renderer(
				{ messages: this.messages, toolExecutions: this.toolExecutions, isStreaming: this.isStreaming },
				{ expanded: this.expanded, outputPad: this.outputPad, showImages: this.showImages },
				theme,
			);
		} catch {
			// A renderer failure must not corrupt the transcript. The regular
			// renderer will resume on reload or when the extension is removed.
			return;
		}
		if (component) this.addChild(component);

		if (!this.showImages || !getCapabilities().images) return;
		for (const execution of this.toolExecutions) {
			for (const [index, content] of (execution.result?.content ?? []).entries()) {
				if (content.type !== "image" || !content.data || !content.mimeType) continue;
				const key = `${execution.toolCallId}:${index}`;
				let image = this.convertedImages.get(key) ?? content;
				if (getCapabilities().images === "kitty" && image.mimeType !== "image/png") {
					convertToPng(content.data, content.mimeType).then((converted) => {
						if (!converted) return;
						this.convertedImages.set(key, converted);
						this.rebuild();
						this.ui.requestRender();
					});
					continue;
				}
				this.addChild(new Spacer(1));
				this.addChild(
					new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ maxWidthCells: this.imageWidthCells },
					),
				);
			}
		}
	}
}
