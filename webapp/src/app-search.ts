import { z } from "zod";

// The editor's address carries what is open over the map, so a reload or a
// shared link opens it again: `/?preferences=true&tab=colors`.
export const PREFERENCE_TABS = [
  "saving",
  "colors",
  "backup",
  "privacy",
] as const;
export type PreferenceTab = (typeof PREFERENCE_TABS)[number];

// The editor route's typed search. A value it does not know is dropped rather
// than failing the page (an unknown tab shows saving), and other parameters,
// such as a sign-in error, pass through untouched.
export const appSearchSchema = z.looseObject({
  preferences: z.literal(true).optional().catch(undefined),
  tab: z.enum(PREFERENCE_TABS).optional().catch(undefined),
});
export type AppSearch = z.infer<typeof appSearchSchema>;
