/** JSON transport and leased preparation polling, independent of application stores. */
export class ApiError extends Error {
    constructor(message, detail = {}) { super(message); Object.assign(this, detail); }
}

export function createTransport(fetcher = (...args) => globalThis.fetch(...args)) {
    const delay = (ms, signal) => new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        signal?.addEventListener('abort', abort, {once:true});
        if (signal?.aborted) abort();
    });
    async function request(url, signal, data, progress = () => {}) {
        let token;
        try {
            while (true) {
                signal?.throwIfAborted();
                const options = {signal};
                let target = url;
                if (data !== undefined) {
                    options.method = 'POST';
                    options.headers = {'Content-Type':'application/json'};
                    options.body = JSON.stringify({...data, ...(token ? {order_token:token} : {})});
                } else if (token) target += (url.includes('?') ? '&' : '?') + new URLSearchParams({order_token:token});
                const response = await fetcher(target, options);
                let result;
                try { result = await response.json(); }
                catch { throw new ApiError('Server returned an invalid response', {status:response.status, retryable:true}); }
                if (!response.ok) throw new ApiError(result.error || 'Unable to load this folder', {...result, status:response.status});
                if (response.status !== 202 || result.status !== 'preparing') return result;
                if (token && token !== result.token) releasePreparation(token);
                token = result.token;
                progress(result);
                await delay(150, signal);
            }
        } finally { if (token) releasePreparation(token); }
    }
    function releasePreparation(token) {
        fetcher('/api/order/cancel', {method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({token})}).catch(() => {});
    }
    return {request};
}
