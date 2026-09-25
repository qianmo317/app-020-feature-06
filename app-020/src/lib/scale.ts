import type { Pt } from '../model';
import { dist } from './geometry';

/** 双向校核的醒目提示阈值：两个来源反算的比例相对偏差超过 3% */
export const SCALE_WARN_THRESHOLD = 0.03;

/**
 * 参照线反算毫米每像素。
 * 底图像素距离 = 图纸线长 / 当前比例 —— 几何随底图重算（follow）时该像素距离是不变量，
 * 因此反算值与「当前比例填得对不对」无关，是独立的物理测量。真实毫米数 / 像素距离即真实比例。
 */
export function scaleFromRefLine(a: Pt, b: Pt, realLengthM: number, currentScaleMmPerPx: number): number | null {
  const lineMm = dist(a, b);
  if (!(lineMm > 0) || !(realLengthM > 0) || !(currentScaleMmPerPx > 0)) return null;
  const pxLen = lineMm / currentScaleMmPerPx;
  return (realLengthM * 1000) / pxLen;
}

/**
 * 面积反推毫米每像素：假设房间多边形是照底图描的，
 * 描出面积与真实面积的线性比开平方即为当前比例的修正系数。
 */
export function scaleFromArea(drawnAreaM2: number, realAreaM2: number, currentScaleMmPerPx: number): number | null {
  if (!(drawnAreaM2 > 0) || !(realAreaM2 > 0) || !(currentScaleMmPerPx > 0)) return null;
  return currentScaleMmPerPx * Math.sqrt(realAreaM2 / drawnAreaM2);
}

/** 两个比例来源的相对偏差（对称，相对均值），用于 3% 阈值判定与界面显示 */
export function scaleDeviation(a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) return 0;
  return Math.abs(a - b) / ((a + b) / 2);
}
