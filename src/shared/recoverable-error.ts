/**
 * A tool call rejected because of *its own* arguments or an unmet precondition the model can
 * resolve without the user: a missing required field, an id that does not exist, an illegal
 * status transition.
 *
 * This is not a failure of the tool. It is the same class of outcome as bash's non-zero exit
 * code — data the model reacts to — and it is deliberately *not* surfaced to the user as an
 * error, because the model normally fixes it on the next call and a red bubble in the chat
 * would report a fault that never happened.
 *
 * Throw a plain `Error` instead when the user genuinely has to act or know:
 *   - a security guard refused the call (the user may need to adjust security.json),
 *   - progress needs a human decision (`/tasks approve <id>`),
 *   - state is corrupt and needs manual repair,
 *   - the tool itself broke (I/O failure, a bug).
 *
 * The test is "can the model resolve this alone?", not "how severe is it?".
 *
 * Lives in `shared/` because domain code raises it (`src/tasks/` transitions) while only the
 * tool layer interprets it: `withToolDetails` converts it at the tool boundary into a normal
 * result carrying `recoverable: true`. That conversion is required — the pi SDK discards
 * thrown error objects and keeps only `error.message`, so the type cannot survive on its own.
 */
export class RecoverableToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoverableToolError";
	}
}
