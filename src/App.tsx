import { createSignal } from "solid-js";
import type { JSX } from "solid-js";

function clsx(slices: JSX.DOMAttributes<HTMLDivElement>["class"][]) {
  return slices.join(" ");
}

class Vector2 {
  public x: number;
  public y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

}

export function App() {
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [moving, setMoving] = createSignal(false);

  const vMouseDown = new Vector2();
  const vPrevPos = new Vector2();
  let activePointerId: number | undefined;

  function stopMoving(e: PointerEvent) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = undefined;
    setMoving(false);
  }

  return (
    <div
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || activePointerId !== undefined) return;
        if (e.target instanceof Element && e.target.closest("[data-no-pan]")) return;

        e.currentTarget.setPointerCapture(e.pointerId);
        activePointerId = e.pointerId;
        vMouseDown.set(e.clientX, e.clientY);
        vPrevPos.set(left(), top());
        setMoving(true);
        e.preventDefault();
      }}
      onPointerUp={stopMoving}
      onPointerCancel={stopMoving}
      onLostPointerCapture={stopMoving}
      onPointerMove={(e) => {
        if (e.pointerId !== activePointerId) return;

        const dx = e.clientX - vMouseDown.x;
        const dy = e.clientY - vMouseDown.y;
        setLeft(vPrevPos.x + dx);
        setTop(vPrevPos.y + dy);
      }}
      class="overflow-hidden w-screen h-screen bg-stone-900 relative touch-none select-none"
      style={{ cursor: moving() ? "grabbing" : "grab" }}
    >
      <div
        class="absolute w-full h-full"
        style={{ transform: `translate(${left()}px, ${top()}px)` }}
      >
        <div class="relative w-full h-full">
          <div
            class={clsx([
              "bg-green-300 border rounded-md",
              "shadow-sm/30 cursor-pointer",
              "px-2.5 py-0.75 select-none",
              "absolute",
            ])}
            data-no-pan
            style={{ top: `200px`, left: `200px` }}
          >
            <span>User</span>
          </div>

          <div
            class={clsx([
              "bg-green-300 border rounded-md",
              "shadow-sm/30 cursor-pointer",
              "px-2.5 py-0.75 select-none",
              "absolute",
            ])}
            data-no-pan
            style={{ top: `200px`, left: `320px` }}
          >
            <span>id</span>
          </div>
        </div>
      </div>
    </div>
  );
}
