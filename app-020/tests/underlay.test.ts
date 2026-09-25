/**
 * 底图比例双向校核测试：
 * - 纯函数：参照线反算 / 面积反推 / 3% 偏差阈值（src/lib/scale.ts）
 * - store：applyUnderlayScale 的 follow（已有图形随底图重算）与 keep（保持原样）语义
 * - 引擎：两个独立来源反算的比例相差 >3% 时产出 UNDERLAY_SCALE_MISMATCH 警告
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SCALE_WARN_THRESHOLD, scaleDeviation, scaleFromArea, scaleFromRefLine } from '../src/lib/scale';
import {
  getState,
  addBuilding,
  deleteBuilding,
  addFloor,
  addRoom,
  addFacility,
  setUnderlay,
  applyUnderlayScale,
  setMark,
} from '../src/store/store';
import { mkFloor, mkRoom, rect } from './helpers';
import { validateFloor } from '../src/lib/engine';
import type { Underlay } from '../src/model';

const mkUnderlay = (patch?: Partial<Underlay>): Underlay => ({
  key: 'u/test',
  wPx: 1600,
  hPx: 1200,
  offsetX: 0,
  offsetY: 0,
  scaleMmPerPx: 10,
  opacity: 0.5,
  visible: true,
  ...patch,
});

describe('比例反算纯函数', () => {
  it('L1 参照线反算：真实毫米数 / 底图像素距离（图上长 ÷ 当前比例）', () => {
    // 图上 10000mm、当前 10mm/px → 1000px；真实 10m → 10mm/px（比例本来就对）
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 10000, y: 0 }, 10, 10)).toBeCloseTo(10, 6);
    // 真实 20m → 比例应为 20（当前填错了，差 2 倍）
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 10000, y: 0 }, 20, 10)).toBeCloseTo(20, 6);
    // 斜线按欧氏距离：图上 5000mm、当前 5 → 1000px；真实 10m → 10
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 3000, y: 4000 }, 10, 5)).toBeCloseTo(10, 6);
  });

  it('L2 参照线反算的非法输入返回 null（不参与校核）', () => {
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 0, y: 0 }, 10, 10)).toBeNull(); // 零长度线
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 1000, y: 0 }, 0, 10)).toBeNull(); // 未填真实长度
    expect(scaleFromRefLine({ x: 0, y: 0 }, { x: 1000, y: 0 }, 10, 0)).toBeNull(); // 当前比例无效
  });

  it('L3 面积反推：面积比开平方修正当前比例', () => {
    expect(scaleFromArea(100, 100, 10)).toBeCloseTo(10, 6);
    expect(scaleFromArea(100, 400, 10)).toBeCloseTo(20, 6); // 面积 4 倍 → 线性 2 倍
    expect(scaleFromArea(100, 25, 10)).toBeCloseTo(5, 6);
    expect(scaleFromArea(0, 100, 10)).toBeNull();
    expect(scaleFromArea(100, 0, 10)).toBeNull();
  });

  it('L4 偏差对称、以 3% 为醒目阈值', () => {
    expect(SCALE_WARN_THRESHOLD).toBe(0.03);
    expect(scaleDeviation(10, 10)).toBe(0);
    expect(scaleDeviation(10, 11)).toBeCloseTo(scaleDeviation(11, 10), 12);
    expect(scaleDeviation(10, 10.2)).toBeLessThan(SCALE_WARN_THRESHOLD);
    expect(scaleDeviation(10, 10.5)).toBeGreaterThan(SCALE_WARN_THRESHOLD);
  });
});

describe('applyUnderlayScale：改比例时已有图形的处理策略', () => {
  let bid = '';
  let fid = '';
  beforeEach(() => {
    for (const b of [...getState().buildings]) deleteBuilding(b.id);
    bid = addBuilding('测试楼', 'office');
    fid = addFloor(bid, 1);
  });

  it('U1 keep（缺省策略）：仅改比例数值，房间/设施不动、不触发重新校验', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office');
    const xid = addFacility(fid, 'extinguisher', 2000, 1000);
    setUnderlay(fid, mkUnderlay({ rescalePolicy: 'keep' }));
    const before = getState().floors[fid];
    applyUnderlayScale(fid, 20);
    const f = getState().floors[fid];
    expect(f).not.toBe(before); // 楼层引用仍替换（订阅响应性）
    expect(f.underlay!.scaleMmPerPx).toBe(20);
    expect(f.rooms.find((r) => r.id === rid)!.polygon).toEqual(rect(0, 0, 8, 6));
    expect(f.rooms.find((r) => r.id === rid)!.areaM2).toBeCloseTo(48, 6);
    const fac = f.facilities.find((x) => x.id === xid)!;
    expect([fac.x, fac.y]).toEqual([2000, 1000]);
    expect(f.version).toBe(before.version); // 几何没变，不触发重新校验
  });

  it('U2 follow：房间/设施/参照线/「您在此」绕底图锚点缩放，面积重算、版本 +1', () => {
    const rid = addRoom(fid, rect(0, 0, 8, 6), '101室', 'office'); // 48㎡
    const xid = addFacility(fid, 'extinguisher', 2000, 1000);
    setUnderlay(fid, mkUnderlay({
      rescalePolicy: 'follow',
      offsetX: 1000,
      offsetY: 500,
      refLine: { ax: 1000, ay: 500, bx: 11000, by: 500, realLengthM: 10 },
    }));
    setMark(fid, { x: 3000, y: 1500 });
    const v0 = getState().floors[fid].version;
    applyUnderlayScale(fid, 20); // k=2，锚点 (1000, 500)
    const f = getState().floors[fid];
    expect(f.underlay!.scaleMmPerPx).toBe(20);
    const room = f.rooms.find((r) => r.id === rid)!;
    // (0,0) → (1000+(0-1000)*2, 500+(0-500)*2)；(8000,6000) → (1000+7000*2, 500+5500*2)
    expect(room.polygon[0]).toEqual({ x: -1000, y: -500 });
    expect(room.polygon[2]).toEqual({ x: 15000, y: 11500 });
    expect(room.areaM2).toBeCloseTo(48 * 4, 6); // 面积 ×k²
    const fac = f.facilities.find((x) => x.id === xid)!;
    expect([fac.x, fac.y]).toEqual([3000, 1500]);
    // 参照线跟着缩放（保持与底图像素的相对位置 → 反算值不漂移）
    expect(f.underlay!.refLine).toMatchObject({ ax: 1000, ay: 500, bx: 21000, by: 500 });
    // 「您在此」标记跟着缩放
    expect(getState().marks[fid]).toEqual({ x: 5000, y: 2500 });
    expect(f.version).toBe(v0 + 1); // 几何变了，触发重新校验
  });

  it('U3 follow 重算后反算值不漂移：应用参照线反算值后，两个来源偏差均归零', () => {
    const rid = addRoom(fid, rect(0, 0, 10, 10), '101室', 'office'); // 100㎡
    setUnderlay(fid, mkUnderlay({
      rescalePolicy: 'follow',
      refLine: { ax: 0, ay: 0, bx: 10000, by: 0, realLengthM: 20 }, // 反算 20
      areaCheck: { roomId: rid, realAreaM2: 400 }, // 反推 10×√4 = 20
    }));
    const u0 = getState().floors[fid].underlay!;
    const line0 = scaleFromRefLine({ x: 0, y: 0 }, { x: 10000, y: 0 }, 20, u0.scaleMmPerPx)!;
    expect(line0).toBeCloseTo(20, 6);
    // 应用反算值（几何随底图重算，k=2）
    applyUnderlayScale(fid, line0);
    const f1 = getState().floors[fid];
    const u1 = f1.underlay!;
    expect(u1.scaleMmPerPx).toBeCloseTo(20, 6);
    // 参照线反算值是独立物理测量，不随重算漂移
    const rl = u1.refLine!;
    const line1 = scaleFromRefLine({ x: rl.ax, y: rl.ay }, { x: rl.bx, y: rl.by }, rl.realLengthM, u1.scaleMmPerPx)!;
    expect(line1).toBeCloseTo(line0, 6);
    // 房间面积被修正到真实值，面积反推与当前比例一致
    const room1 = f1.rooms.find((r) => r.id === rid)!;
    expect(room1.areaM2).toBeCloseTo(400, 4);
    const area1 = scaleFromArea(room1.areaM2, 400, u1.scaleMmPerPx)!;
    expect(scaleDeviation(line1, u1.scaleMmPerPx)).toBeLessThan(1e-6);
    expect(scaleDeviation(area1, u1.scaleMmPerPx)).toBeLessThan(1e-6);
  });

  it('U4 非法比例值（0/负数/NaN）不生效', () => {
    setUnderlay(fid, mkUnderlay({ rescalePolicy: 'follow' }));
    applyUnderlayScale(fid, 0);
    applyUnderlayScale(fid, -5);
    applyUnderlayScale(fid, NaN);
    expect(getState().floors[fid].underlay!.scaleMmPerPx).toBe(10);
  });
});

describe('引擎：UNDERLAY_SCALE_MISMATCH 校核警告', () => {
  it('E1 两个来源相差 >3% → 醒目警告；一致 → 无警告', () => {
    const room = mkRoom('101室', 'office', rect(0, 0, 10, 10)); // 100㎡
    const { floor, rules } = mkFloor([room], [{ kind: 'exit', x: 1, y: 1 }]);
    floor.underlay = mkUnderlay({
      refLine: { ax: 0, ay: 0, bx: 10000, by: 0, realLengthM: 10 }, // 反算 10
      areaCheck: { roomId: room.id, realAreaM2: 200 }, // 反推 10×√2 ≈ 14.14
    });
    const mism = validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH');
    expect(mism.length).toBe(1);
    expect(mism[0].severity).toBe('warning');
    expect(mism[0].message).toContain('14.14');
    expect(mism[0].point).toEqual({ x: 5000, y: 0 }); // 定位到参照线中点
    // 面积真实值改为与描出一致 → 两来源都指向 10 → 无警告
    floor.underlay = { ...floor.underlay, areaCheck: { roomId: room.id, realAreaM2: 100 } };
    expect(validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH').length).toBe(0);
  });

  it('E2 单一来源与当前比例相差 >3% → 警告；≤3% 或无底图 → 无', () => {
    const room = mkRoom('101室', 'office', rect(0, 0, 10, 10));
    const { floor, rules } = mkFloor([room], [{ kind: 'exit', x: 1, y: 1 }]);
    // 仅参照线：反算 20 vs 当前 10 → 66.7% 超阈
    floor.underlay = mkUnderlay({ refLine: { ax: 0, ay: 0, bx: 10000, by: 0, realLengthM: 20 } });
    expect(validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH').length).toBe(1);
    // 仅面积校核：反推 10.1 vs 当前 10 → ≈1% 不报警
    floor.underlay = mkUnderlay({ areaCheck: { roomId: room.id, realAreaM2: 102.01 } });
    expect(validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH').length).toBe(0);
    // 无底图 → 无警告
    floor.underlay = undefined;
    expect(validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH').length).toBe(0);
  });

  it('E3 校核用的房间被删除后不再报警（不残留悬空引用）', () => {
    const room = mkRoom('101室', 'office', rect(0, 0, 10, 10));
    const { floor, rules } = mkFloor([room], [{ kind: 'exit', x: 1, y: 1 }]);
    floor.underlay = mkUnderlay({ areaCheck: { roomId: 'room-已删除', realAreaM2: 500 } });
    expect(validateFloor(floor, rules).items.filter((i) => i.type === 'UNDERLAY_SCALE_MISMATCH').length).toBe(0);
  });
});
