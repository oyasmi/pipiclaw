import { TUI_CHANNEL_ID } from "../channel/channel-id.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";

/**
 * The terminal never joins `dots/bindings.json` and does not run the task driver or event watcher,
 * so a task or event delivering to it would be created and then never run (spec 058, D13/D18).
 * Refuse at creation, with the only workable next step.
 */
export function assertBackgroundDeliverable(channelId: string, what: "task" | "event"): void {
	if (channelId !== TUI_CHANNEL_ID) return;
	throw new RecoverableToolError(
		`The terminal does not run background work, so this ${what} would never run. Tell the user to create the ${what} from a DingTalk channel bound to this dot.`,
	);
}
