import { randomUUID } from 'crypto';

/** Own every response and timer by request ID. Late responses are ignored. */
export class BridgeRequests {
  private pending = new Map<string, { id: string; timer: ReturnType<typeof setTimeout>; resolve: (value: any) => void; reject: (error: Error) => void }>();
  constructor(private send: (message: any) => boolean) {}

  request(type: string, responseType: string, payload: any, timeoutMs: number): Promise<any> {
    if (this.pending.has(responseType)) return Promise.reject(new Error('Wait for the current Premiere operation to finish.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pending.get(responseType)?.id !== id) return;
        this.pending.delete(responseType);
        reject(new Error('Premiere did not confirm the operation in time.'));
      }, timeoutMs);
      this.pending.set(responseType, { id, timer, resolve, reject });
      try {
        if (!this.send({ ...payload, type, requestId: id })) throw new Error('Not connected to Premiere');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(responseType);
        reject(error);
      }
    });
  }

  receive(message: any): boolean {
    const entry = this.pending.get(message.type);
    if (!entry || entry.id !== message.requestId) return false;
    clearTimeout(entry.timer);
    this.pending.delete(message.type);
    entry.resolve(message);
    return true;
  }

  disconnect(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Premiere disconnected before confirming the operation.'));
    }
    this.pending.clear();
  }
}
