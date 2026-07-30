import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	createRestartInvocation,
	executeRestart,
	InteractiveMode,
	type RestartInvocation,
	type RestartRuntime,
} from "../src/modes/interactive/interactive-mode.ts";

const tempDirs: string[] = [];

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-restart-current-session-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function createSessionManager(options: {
	persisted?: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	usesDefaultSessionDir?: boolean;
}): SessionManager {
	return {
		isPersisted: () => options.persisted ?? true,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => options.sessionId ?? "test-session",
		getSessionDir: () => options.sessionDir ?? "/tmp/pi-sessions",
		usesDefaultSessionDir: () => options.usesDefaultSessionDir ?? true,
	} as unknown as SessionManager;
}

type ShutdownThis = {
	isShuttingDown: boolean;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type RestartCommandThis = {
	session: { isStreaming: boolean; isCompacting: boolean; isBashRunning: boolean };
	sessionManager: SessionManager;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	shutdown: (options?: { restart?: () => never }) => Promise<void>;
};

type InteractiveModePrototypeForRestart = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean; restart?: () => never }): Promise<void>;
	handleRestartCommand(this: RestartCommandThis): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeForRestart;

function createRestartRuntime(overrides: Partial<RestartRuntime> = {}): RestartRuntime {
	return {
		execPath: "/usr/local/bin/node",
		entrypoint: "/opt/pi/dist/cli.js",
		env: {},
		execve: vi.fn() as unknown as NonNullable<NodeJS.Process["execve"]>,
		platform: "darwin",
		isBunRuntime: false,
		isFile: () => true,
		isReadable: () => true,
		isExecutable: () => true,
		isSameFile: () => false,
		...overrides,
	};
}

class Restarted extends Error {}
class ExitedInsteadOfRestarting extends Error {}

function createShutdownContext(order: string[], sessionManager: SessionManager): ShutdownThis {
	return {
		isShuttingDown: false,
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("restart current session", () => {
	it("registers /restart as a built-in command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "restart",
			description: "Restart pi and resume the current session",
		});
	});

	it("builds canonical argv for the persisted session", () => {
		const execve = vi.fn() as unknown as NonNullable<NodeJS.Process["execve"]>;
		const env = { TEST_RESTART: "1" };
		const result = createRestartInvocation(
			createSessionManager({
				sessionFile: createTempFile(),
				sessionId: "session-123",
				sessionDir: "/tmp/custom sessions",
				usesDefaultSessionDir: false,
			}),
			createRestartRuntime({ env, execve }),
		);

		expect(result).toEqual({
			ok: true,
			invocation: {
				executable: "/usr/local/bin/node",
				args: [
					"/usr/local/bin/node",
					"/opt/pi/dist/cli.js",
					"--session-dir",
					"/tmp/custom sessions",
					"--session",
					"session-123",
				],
				env,
				execve,
			},
		});
	});

	it("builds canonical argv without a custom session directory", () => {
		const execve = vi.fn() as unknown as NonNullable<NodeJS.Process["execve"]>;
		const result = createRestartInvocation(
			createSessionManager({ sessionFile: createTempFile(), sessionId: "session-123" }),
			createRestartRuntime({ execve }),
		);

		expect(result.ok && result.invocation.args).toEqual([
			"/usr/local/bin/node",
			"/opt/pi/dist/cli.js",
			"--session",
			"session-123",
		]);
	});

	it("rejects sessions that cannot be resumed exactly", () => {
		const execve = vi.fn() as unknown as NonNullable<NodeJS.Process["execve"]>;
		const runtime = createRestartRuntime({ execve });

		expect(
			createRestartInvocation(createSessionManager({ persisted: false, sessionFile: createTempFile() }), runtime),
		).toEqual({ ok: false, error: "The current session is not persisted and cannot be restarted." });
		expect(createRestartInvocation(createSessionManager({ sessionFile: "/missing/session.jsonl" }), runtime)).toEqual(
			{
				ok: false,
				error: "The current session file is unavailable and cannot be restarted.",
			},
		);
	});

	it("rejects runtimes that cannot replace the current process", () => {
		const sessionManager = createSessionManager({ sessionFile: createTempFile() });
		const unsupported = {
			ok: false,
			error: "Process restart is not supported by this runtime. Use /quit and resume manually.",
		};

		expect(createRestartInvocation(sessionManager, createRestartRuntime({ execve: undefined }))).toEqual(unsupported);
		expect(createRestartInvocation(sessionManager, createRestartRuntime({ platform: "win32" }))).toEqual(unsupported);
		expect(createRestartInvocation(sessionManager, createRestartRuntime({ isBunRuntime: true }))).toEqual(
			unsupported,
		);
		expect(
			createRestartInvocation(
				sessionManager,
				createRestartRuntime({
					entrypoint: "/usr/local/bin/node",
					isSameFile: () => true,
				}),
			),
		).toEqual({
			ok: false,
			error: "Standalone Pi executables cannot restart in place. Use /quit and resume manually.",
		});
		expect(createRestartInvocation(sessionManager, createRestartRuntime({ entrypoint: undefined }))).toEqual({
			ok: false,
			error: "Pi's executable entrypoint is unavailable. Use /quit and resume manually.",
		});
	});

	it("rejects unavailable executable files before cleanup", () => {
		const sessionManager = createSessionManager({ sessionFile: createTempFile() });

		expect(
			createRestartInvocation(
				sessionManager,
				createRestartRuntime({ isFile: (file) => file !== "/usr/local/bin/node" }),
			),
		).toEqual({ ok: false, error: "Pi's runtime executable is unavailable. Use /quit and resume manually." });
		expect(
			createRestartInvocation(
				sessionManager,
				createRestartRuntime({ isFile: (file) => file !== "/opt/pi/dist/cli.js" }),
			),
		).toEqual({ ok: false, error: "Pi's executable entrypoint is unavailable. Use /quit and resume manually." });
	});

	it("rejects inaccessible restart and session files before cleanup", () => {
		const sessionFile = createTempFile();
		const sessionManager = createSessionManager({ sessionFile });

		expect(createRestartInvocation(sessionManager, createRestartRuntime({ isExecutable: () => false }))).toEqual({
			ok: false,
			error: "Pi's runtime executable is unavailable. Use /quit and resume manually.",
		});
		expect(
			createRestartInvocation(
				sessionManager,
				createRestartRuntime({ isReadable: (file) => file !== "/opt/pi/dist/cli.js" }),
			),
		).toEqual({
			ok: false,
			error: "Pi's executable entrypoint is unavailable. Use /quit and resume manually.",
		});
		expect(
			createRestartInvocation(sessionManager, createRestartRuntime({ isReadable: (file) => file !== sessionFile })),
		).toEqual({
			ok: false,
			error: "The current session file is unavailable and cannot be restarted.",
		});
	});

	it.each([
		{
			state: "isStreaming" as const,
			warning: "Wait for the current response to finish before restarting.",
		},
		{
			state: "isCompacting" as const,
			warning: "Wait for compaction to finish before restarting.",
		},
		{
			state: "isBashRunning" as const,
			warning: "Wait for the current bash command to finish before restarting.",
		},
	])("refuses restart while $state", async ({ state, warning }) => {
		const session = { isStreaming: false, isCompacting: false, isBashRunning: false };
		session[state] = true;
		const showWarning = vi.fn();
		const showError = vi.fn();
		const shutdown = vi.fn(async () => {});
		const context = {
			session,
			sessionManager: createSessionManager({ sessionFile: createTempFile() }),
			showWarning,
			showError,
			shutdown,
		} satisfies RestartCommandThis;

		await interactiveModePrototype.handleRestartCommand.call(context);

		expect(showWarning).toHaveBeenCalledWith(warning);
		expect(showError).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("reports exec failure after terminal cleanup", () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ExitedInsteadOfRestarting();
		}) as typeof process.exit);
		const stderrWrite = vi
			.spyOn(process.stderr, "write")
			.mockImplementation((() => true) as typeof process.stderr.write);
		const invocation = {
			executable: "/usr/local/bin/node",
			args: ["/usr/local/bin/node", "/missing/pi.js", "--session", "session-123"],
			env: {},
			execve: (() => {
				throw new Error("ENOENT");
			}) as RestartInvocation["execve"],
		} satisfies RestartInvocation;

		expect(() => executeRestart(invocation)).toThrow(ExitedInsteadOfRestarting);
		expect(stderrWrite).toHaveBeenCalledWith("Failed to restart pi: ENOENT\n");
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it("finishes interactive cleanup before replacing the process", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ExitedInsteadOfRestarting();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		const order: string[] = [];
		const context = createShutdownContext(
			order,
			createSessionManager({ sessionFile: createTempFile(), sessionId: "session-123" }),
		);
		const invocation = {
			executable: "/usr/local/bin/node",
			args: ["/usr/local/bin/node", "/opt/pi/dist/cli.js", "--session", "session-123"],
			env: {},
			execve: (() => {
				order.push("restart");
				throw new Restarted();
			}) as RestartInvocation["execve"],
		} satisfies RestartInvocation;

		let thrown: unknown;
		try {
			await interactiveModePrototype.shutdown.call(context, {
				restart: () => invocation.execve(invocation.executable, invocation.args, invocation.env),
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Restarted);
		expect(order).toEqual(["drainInput", "stop", "dispose", "restart"]);
		expect(stdoutWrite).not.toHaveBeenCalled();
	});
});
