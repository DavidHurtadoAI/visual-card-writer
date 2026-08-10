export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

export function zoomFromWheel(currentZoom: number, deltaY: number): number {
  const next = currentZoom * Math.exp(-deltaY * 0.0015);
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 1000) / 1000;
}

export function anchoredScrollOffset(
  scrollOffset: number,
  pointerOffset: number,
  leadingPadding: number,
  previousZoom: number,
  nextZoom: number
): number {
  const worldOffset = (scrollOffset + pointerOffset - leadingPadding) / previousZoom;
  return Math.max(0, worldOffset * nextZoom - pointerOffset + leadingPadding);
}

export function centeredScrollOffset(
  currentScroll: number,
  viewportStart: number,
  viewportSize: number,
  itemStart: number,
  itemSize: number,
  maximumScroll: number
): number {
  const itemCenterInViewport = itemStart - viewportStart + itemSize / 2;
  const target = currentScroll + itemCenterInViewport - viewportSize / 2;
  return Math.min(Math.max(0, target), Math.max(0, maximumScroll));
}

export function scrollAnimationDuration(distance: number): number {
  return Math.round(Math.min(460, 220 + Math.max(0, distance) * 0.18));
}

export function resizeWorldDelta(pointerDelta: number, scrollDelta: number, zoom: number): number {
  return (pointerDelta + scrollDelta) / Math.max(MIN_ZOOM, zoom);
}

export function edgeAutoScrollVelocity(
  pointerPosition: number,
  viewportStart: number,
  viewportEnd: number,
  edgeZone = 56,
  maximumVelocity = 560
): number {
  if (pointerPosition > viewportEnd - edgeZone) {
    const intensity = Math.min(1, Math.max(0, (pointerPosition - (viewportEnd - edgeZone)) / edgeZone));
    return maximumVelocity * intensity * intensity;
  }
  if (pointerPosition < viewportStart + edgeZone) {
    const intensity = Math.min(1, Math.max(0, (viewportStart + edgeZone - pointerPosition) / edgeZone));
    return -maximumVelocity * intensity * intensity;
  }
  return 0;
}
