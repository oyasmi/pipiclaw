/** A current-state fault the deployer must fix before starting; render without a stack. */
export class StartupRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StartupRefusal";
	}
}
