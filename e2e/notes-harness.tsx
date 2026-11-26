import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { NoteView } from "../webapp/src/NotesPanel";
import "../webapp/src/index.css";

// Mounts the notes as a shared link shows them, read only and written by
// someone else, with whatever note a test hands over.
const [note, setNote] = createSignal("");

declare global {
  interface Window {
    showNote: (note: string) => void;
  }
}
window.showNote = setNote;
render(
  () => (
    <div class="flex h-screen flex-col">
      <NoteView note={note()} />
    </div>
  ),
  document.getElementById("root") as HTMLElement,
);
