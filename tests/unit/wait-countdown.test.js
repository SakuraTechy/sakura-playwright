import test from 'node:test';
import assert from 'node:assert/strict';
import { waitWithCountdown } from '../../src/runner/step-runner.js';
import { createExecutionLogger } from '../../src/reporting/execution-logger.js';

test('等待动作按秒输出倒计时且保持总等待时长', async () => {
  const logger = createExecutionLogger(() => {});
  const intervals = [];
  const duration = await waitWithCountdown(
    2500,
    (seconds) => logger.info('step', `步骤 1：等待，正在执行：倒计时<${seconds}s>`),
    async (intervalMs) => intervals.push(intervalMs),
  );

  assert.equal(duration, 2500);
  assert.deepEqual(intervals, [1000, 1000, 500]);
  assert.deepEqual(logger.events.map((event) => event.message), [
    '步骤 1：等待，正在执行：倒计时<3s>',
    '步骤 1：等待，正在执行：倒计时<2s>',
    '步骤 1：等待，正在执行：倒计时<1s>',
  ]);
});
