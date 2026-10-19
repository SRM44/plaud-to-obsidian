export class PlaudSyncError extends Error {
	// kind: 'auth' (run `plaud login`), 'network', 'config', or 'busy' (another sync is running).
	constructor(kind, message) {
		super(message);
		this.name = 'PlaudSyncError';
		this.kind = kind;
	}
}

