import { z } from "zod";

// Zod compiles object schemas with `new Function` when the page allows it, and
// finds out by trying once, when the first object schema is defined. The
// Content Security Policy forbids it, and the browser reports the attempt even
// though Zod catches the failure. index.tsx imports this first, before any
// module that defines a schema.
z.config({ jitless: true });
