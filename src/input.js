/**
 * Pointer handling. One Pointer Events code path covers mouse, touch and pen.
 *
 * A single active pointer id is tracked, which is what enforces "one rope at a time":
 * a second finger is ignored until the first lifts.
 */
export function attachInput(canvas, handlers) {
  let activeId = null;

  const localPos = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (activeId !== null) return;
    const p = localPos(event);
    if (!handlers.onGrab(p.x, p.y, event.pointerType !== 'mouse')) return;

    activeId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-grabbing');
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activeId) return;
    const p = localPos(event);
    handlers.onMove(p.x, p.y);
  });

  const end = (event) => {
    if (event.pointerId !== activeId) return;
    activeId = null;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Already released (pointercancel can fire after capture is gone).
    }
    canvas.classList.remove('is-grabbing');
    handlers.onRelease();
  };

  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // A drag that leaves the window still needs to end, or the rope stays glued on.
  window.addEventListener('blur', () => {
    if (activeId === null) return;
    activeId = null;
    canvas.classList.remove('is-grabbing');
    handlers.onRelease();
  });
}
