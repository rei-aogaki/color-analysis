import { analyzePixels } from '../analysis/histogram.ts';
import type { Histogram } from '../analysis/histogram.ts';
import { serialize } from '../export/serialize.ts';
import type { Request, Response } from '../types.ts';

let histogram: Histogram | undefined;
let currentJob = 0;
let exportToken = 0;
const send = (message: Response, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data;
  if (!msg || !Number.isSafeInteger(msg.jobId)) return;
  const phase = msg.type === 'start' ? 'analysis' : msg.type === 'query' ? 'query' : 'export';
  try {
    if (msg.type === 'start') {
      currentJob = msg.jobId;
      const started = performance.now();
      histogram = await analyzePixels(new Uint8ClampedArray(msg.buffer), msg.width, msg.height, msg.options,
        (phase, percent) => send({ type: 'progress', jobId: currentJob, phase, percent }));
      const labels = histogram.familyLabels?.buffer as ArrayBuffer | undefined;
      send({ type: 'complete', jobId: currentJob, summary: histogram.summary, familyLabels: labels,
        top: Array.from(histogram.order.subarray(0, histogram.summary.options.mode === 'families' ? 13 : 10), index => histogram!.row(index)), elapsedMs: performance.now() - started }, labels ? [labels] : []);
    } else if (msg.jobId === currentJob && histogram) {
      if (msg.type === 'query') send({ type: 'page', jobId: currentJob, requestId: msg.requestId, ...histogram.query(msg.query) });
      else if (msg.type === 'cancel-export') { exportToken++; }
      else if (msg.type === 'export') {
        if (!['csv', 'json'].includes(msg.format)) throw new Error('保存形式が正しくありません。');
        const token = ++exportToken;
        const blob = await serialize(histogram, msg.format, () => token !== exportToken);
        if (token === exportToken) send({ type: 'export-ready', jobId: currentJob, requestId: msg.requestId, blob, format: msg.format });
      }
    }
  } catch (error) {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    if (error instanceof Error && error.message === 'EXPORT_CANCELLED' && requestId !== undefined) send({ type: 'export-cancelled', jobId: currentJob, requestId });
    else send({ type: 'error', jobId: msg.jobId, requestId, phase, message: error instanceof Error ? error.message : '処理できませんでした。もう一度お試しください。' });
  }
};
