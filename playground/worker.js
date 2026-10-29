import { handle } from './engine.js';

self.onmessage = (e) => handle(e.data, (m) => self.postMessage(m));
self.postMessage({ type: 'ready' });
