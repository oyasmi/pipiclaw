/**
 * Minimal ANSI color helpers for the TUI. pipiclaw has no chalk dependency, so
 * these are hand-rolled SGR wrappers. Honors NO_COLOR (https://no-color.org) and
 * a non-TTY stdout by degrading to identity functions.
 */
const enabled = !process.env.NO_COLOR && process.stdout.isTTY === true;

function sgr(open: number, close = 0): (text: string) => string {
	if (!enabled) return (text) => text;
	return (text) => `\x1b[${open}m${text}\x1b[${close}m`;
}

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const strikethrough = sgr(9, 29);
export const red = sgr(31);
export const yellow = sgr(33);
export const cyan = sgr(36);
export const gray = sgr(90);
