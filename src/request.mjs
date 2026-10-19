// requestUrl cannot cancel its underlying request. Stop awaiting it on abort so a
// hung request cannot keep the plugin busy forever; late results are ignored.
export function waitForRequest(request, signal) {
	if (!signal) return Promise.resolve().then(request);
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener('abort', abort);
			reject(signal.reason);
		};
		signal.addEventListener('abort', abort, {once: true});
		Promise.resolve().then(request).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}
