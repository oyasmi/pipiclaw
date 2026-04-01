export class FakeExtensionAPI {
	private readonly noopHandlers = new Map<string, (...args: never[]) => unknown>();
	registeredCommands = new Map<
		string,
		{
			description: string;
			handler: (...args: unknown[]) => Promise<void>;
		}
	>();
	sentMessages: unknown[] = [];
	handlers = this.noopHandlers;

	registerCommand(
		name: string,
		config: {
			description: string;
			handler: (...args: unknown[]) => Promise<void>;
		},
	): void {
		this.registeredCommands.set(name, config);
	}

	sendMessage(message: unknown): void {
		this.sentMessages.push(message);
	}

	on(event: string, handler: (...args: never[]) => unknown): void {
		this.handlers.set(event, handler);
	}
}
