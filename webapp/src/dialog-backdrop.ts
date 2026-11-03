// Closes a modal <dialog> when the user clicks its backdrop.
//
// A click on the ::backdrop targets the dialog element itself, but so does a
// click on the dialog's own padding, so the pointer position decides. The press
// must also start on the backdrop: selecting text inside the dialog and
// releasing outside it should not close it.
export function backdropDismiss(close: () => void) {
  let pressedOutside = false;
  const outside = (e: MouseEvent) => {
    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return (
      e.clientX < box.left ||
      e.clientX > box.right ||
      e.clientY < box.top ||
      e.clientY > box.bottom
    );
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      pressedOutside = outside(e);
    },
    onClick: (e: MouseEvent) => {
      if (pressedOutside && outside(e)) close();
      pressedOutside = false;
    },
  };
}
