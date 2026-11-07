// @ts-check
/** 精选动作库（data/exercises.json）加载失败后的重试语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** @param {any} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('首次 404：抛错且不缓存失败结果，重试能成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('not found', { status: 404 });
    return json({ exercises: [{ name: 'Goblet Squat', body_part: 'upper legs' }] });
  };

  // 用查询串拿到独立模块实例，避免和其它用例共享 memo
  const mod = await import(`../js/dataset.js?retry=${Date.now()}`);

  await assert.rejects(mod.loadExercises(), /HTTP 404/);
  const data = await mod.loadExercises();
  assert.equal(data.length, 1);

  // 成功之后命中 memo，不会再打网络
  await mod.loadExercises();
  assert.equal(calls, 2);
});

test('数据集为空时 matchPlan 返回空 Map（降级页只靠课表动作渲染）', async () => {
  const mod = await import(`../js/dataset.js?empty=${Date.now()}`);
  const plan = { days: [{ exercises: [{ key: 'plank', name: '平板支撑' }] }] };
  assert.equal(mod.matchPlan(plan, []).size, 0);
});
