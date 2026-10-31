// Model-based fuzzing of one document with undo history, below the UI. Every
// action is one undo step; the oracle is the stack of views before each step.
import { expect, test } from "bun:test";
import {
  createProjectDocument,
  openProjectDocument,
} from "../src/project-document";
import { EditHistory } from "../src/undo-history";
import {
  canonical,
  checkView,
  FIRST_SEED,
  random,
  SEEDS,
  STEPS,
  tryEdit,
} from "./fuzz-helpers";

// Matches the undo depth the editor keeps (Loro's default stack size).
const UNDO_LIMIT = 100;

function run(seed: number) {
  const rng = random(seed);
  const doc = createProjectDocument(crypto.randomUUID(), "Fuzz", {
    text: "root",
  });
  const history = new EditHistory(doc);
  // Views before each recorded step, and views undone that redo can restore.
  const past: string[] = [];
  const future: string[] = [];
  const log: string[] = [];
  try {
    for (let step = 0; step < STEPS; step++) {
      const before = canonical(doc);
      const roll = rng.next();
      if (roll < 0.15 && past.length) {
        history.undo();
        log.push("undo");
        expect(canonical(doc)).toBe(past.pop() as string);
        future.push(before);
      } else if (roll < 0.22 && future.length) {
        history.redo();
        log.push("redo");
        expect(canonical(doc)).toBe(future.pop() as string);
        past.push(before);
      } else {
        // One to three edits form one undo step, like typing a word. Edits
        // that cancel out still record a step, so change is judged by version.
        const version = doc.version();
        const edits = 1 + (rng.chance(0.2) ? rng.int(3) : 0);
        for (let i = 0; i < edits; i++) log.push(tryEdit(rng, doc));
        history.finishGroup();
        if (doc.version() !== version) {
          past.push(before);
          if (past.length > UNDO_LIMIT) past.shift();
          future.length = 0;
        }
      }
      checkView(doc.view());
      // A saved snapshot reopens to the same document.
      if (rng.chance(0.05)) {
        const reopened = openProjectDocument(doc.id, [doc.snapshot()]);
        try {
          expect(canonical(reopened)).toBe(canonical(doc));
        } finally {
          reopened.destroy();
        }
      }
    }
    // Undo walks all the way back through every remembered step.
    while (past.length) {
      history.undo();
      expect(canonical(doc)).toBe(past.pop() as string);
    }
  } catch (error) {
    throw new Error(
      `seed ${seed} failed after: ${log.slice(-12).join(", ")}\n${String(error)}`,
    );
  } finally {
    history.destroy();
    doc.destroy();
  }
}

test(`random edits, undo and redo keep the document valid and reversible (${SEEDS} seeds × ${STEPS} steps)`, () => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) run(seed);
}, 600_000);
