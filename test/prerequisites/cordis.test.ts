import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Context } from 'cordis';

// Risk: a prerelease lifecycle API may leave old listeners active after unload.
test('Cordis unload awaits effect cleanup and reloading does not duplicate listeners', async (t) => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const source = new EventEmitter();
  let calls = 0;
  let cleanups = 0;
  const plugin = (ctx: Context) => {
    ctx.effect(() => {
      const listener = () => { calls += 1; };
      source.on('message', listener);
      return async () => {
        await Promise.resolve();
        source.off('message', listener);
        cleanups += 1;
      };
    });
  };

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const fiber = await root.plugin(plugin);
    assert.equal(source.listenerCount('message'), 1);
    source.emit('message');
    assert.equal(calls, cycle);
    await fiber.dispose();
    assert.equal(cleanups, cycle);
    assert.equal(source.listenerCount('message'), 0);
    source.emit('message');
    assert.equal(calls, cycle);
  }
});
