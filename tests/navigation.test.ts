import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  anchoredScrollOffset,
  centeredScrollOffset,
  edgeAutoScrollVelocity,
  resizeWorldDelta,
  scrollAnimationDuration,
  zoomFromWheel
} from "../src/navigation";

describe("card viewport navigation", () => {
  it("zooms in and out while respecting the supported range", () => {
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomFromWheel(1, 100)).toBeLessThan(1);
    expect(zoomFromWheel(MAX_ZOOM, -1000)).toBe(MAX_ZOOM);
    expect(zoomFromWheel(MIN_ZOOM, 1000)).toBe(MIN_ZOOM);
  });

  it("keeps the world point below the pointer stable", () => {
    const previousZoom = 1;
    const nextZoom = 1.5;
    const scroll = 240;
    const pointer = 320;
    const padding = 18;
    const worldBefore = (scroll + pointer - padding) / previousZoom;
    const nextScroll = anchoredScrollOffset(scroll, pointer, padding, previousZoom, nextZoom);
    const worldAfter = (nextScroll + pointer - padding) / nextZoom;

    expect(worldAfter).toBeCloseTo(worldBefore);
  });

  it("centers a selected item and clamps the destination to the viewport range", () => {
    expect(centeredScrollOffset(100, 20, 600, 720, 100, 1000)).toBe(550);
    expect(centeredScrollOffset(0, 20, 600, 0, 100, 1000)).toBe(0);
    expect(centeredScrollOffset(900, 20, 600, 1200, 100, 1000)).toBe(1000);
  });

  it("uses viewport scrolling as additional horizontal resize distance", () => {
    expect(resizeWorldDelta(40, 0, 1)).toBe(40);
    expect(resizeWorldDelta(40, 80, 1)).toBe(120);
    expect(resizeWorldDelta(40, 80, 2)).toBe(60);
  });

  it("auto-scrolls progressively near either horizontal edge", () => {
    expect(edgeAutoScrollVelocity(500, 0, 1000)).toBe(0);
    expect(edgeAutoScrollVelocity(980, 0, 1000)).toBeGreaterThan(0);
    expect(edgeAutoScrollVelocity(20, 0, 1000)).toBeLessThan(0);
    expect(edgeAutoScrollVelocity(1000, 0, 1000)).toBe(560);
    expect(edgeAutoScrollVelocity(972, 0, 1000)).toBeLessThan(edgeAutoScrollVelocity(990, 0, 1000));
  });

  it("lengthens selection movement without allowing a slow animation", () => {
    expect(scrollAnimationDuration(0)).toBe(220);
    expect(scrollAnimationDuration(500)).toBe(310);
    expect(scrollAnimationDuration(5000)).toBe(460);
  });
});
