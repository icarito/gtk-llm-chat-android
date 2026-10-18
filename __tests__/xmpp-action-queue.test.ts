import {
  clearActionQueue,
  enqueueActionResponse,
  flushQueuedActionResponses,
  getQueuedActionResponses,
  setActionQueueRunner,
} from '@/xmpp/actionQueue';

describe('cola de respuestas de notificación', () => {
  afterEach(() => {
    clearActionQueue();
    setActionQueueRunner(null);
  });

  it('deduplica por id de acción y ejecuta cada una una sola vez', async () => {
    const runner = jest.fn(async () => {});
    setActionQueueRunner(runner);

    expect(enqueueActionResponse('a')).toBe(true);
    expect(enqueueActionResponse('a')).toBe(false);
    expect(enqueueActionResponse('b')).toBe(true);
    expect(getQueuedActionResponses()).toEqual(['a', 'b']);

    await flushQueuedActionResponses();

    expect(runner.mock.calls).toEqual([['a'], ['b']]);
    expect(getQueuedActionResponses()).toEqual([]);

    await flushQueuedActionResponses();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('reencola una respuesta fallida para el próximo paso a online', async () => {
    const runner = jest.fn(async (): Promise<void> => {
      throw new Error('sin conexión');
    });
    setActionQueueRunner(runner);

    enqueueActionResponse('approval-1');
    await flushQueuedActionResponses();
    expect(getQueuedActionResponses()).toEqual(['approval-1']);

    runner.mockImplementation(async () => {});
    await flushQueuedActionResponses();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(getQueuedActionResponses()).toEqual([]);
  });

  it('conserva la cola si todavía no hay runner', async () => {
    enqueueActionResponse('approval-2');
    await flushQueuedActionResponses();
    expect(getQueuedActionResponses()).toEqual(['approval-2']);
  });
});
