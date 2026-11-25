import { z } from "zod";
import { DEFAULT_QUICK_COLORS } from "./generated/mindgrab-state/model";
import type {
  AnalyticsConsent,
  Color,
  ColorPreferences,
  LegacyPreferences,
  LinkStyle,
  Preference,
  PreferenceName,
  PreferenceRow,
  PreferenceScope,
  PreferenceTarget,
} from "./generated/mindgrab-state/model";
import type { LoroApi } from "./loro-api";
import { DEFAULT_LINK_STYLE } from "./mind-map";
import { isNodeColor, isPickable } from "./node-colors";

// How a person wants Mindgrab to work: how their maps look, where they are
// saved, and their answer about analytics. A preference is set for all of
// their maps (global) or for one map, whose own value wins. Each repository
// keeps them in its browser storage, so they hold offline; an account's also
// sync with its preferences in the cloud.

export type {
  AnalyticsConsent,
  ColorPreferences,
  LegacyPreferences,
  LinkStyle,
  PreferenceName,
  PreferenceRow,
  PreferenceScope,
  PreferenceTarget,
};
export type PreferenceValues = {
  [Name in PreferenceName]: Extract<Preference, { name: Name }>["value"];
};
export type PreferenceLevel = Partial<PreferenceValues>;
// What is set for all maps, and what one map sets for itself.
export interface PreferenceLevels {
  global: PreferenceLevel;
  map: PreferenceLevel;
}
export interface PreferenceChanges {
  set?: PreferenceRow[];
  clear?: PreferenceTarget[];
}

export const PREFERENCE_NAMES = [
  "quickColors",
  "newIdeaColor",
  "linkStyle",
  "saveLocally",
  "saveInCloud",
  "analyticsConsent",
] as const satisfies readonly PreferenceName[];
// Consent to analytics is the person's, never one map's.
export const perMap = (name: PreferenceName) => name !== "analyticsConsent";
// What a map uses: every preference a map can set, each with a default.
export type MapPreferences = Omit<PreferenceValues, "analyticsConsent">;
export const DEFAULT_PREFERENCES: MapPreferences = {
  quickColors: [...DEFAULT_QUICK_COLORS],
  newIdeaColor: "slate",
  linkStyle: DEFAULT_LINK_STYLE,
  saveLocally: true,
  saveInCloud: true,
};
export const NO_PREFERENCES: PreferenceLevels = { global: {}, map: {} };

// A map's own value, else the one for all maps, else the default.
export function resolvePreferences(
  levels: PreferenceLevels = NO_PREFERENCES,
): MapPreferences {
  const { analyticsConsent: _, ...global } = levels.global;
  return { ...DEFAULT_PREFERENCES, ...global, ...levels.map };
}

// Where a map is kept: in this browser, and in the account's cloud.
export interface SavingPreferences {
  local: boolean;
  cloud: boolean;
}
export const SavingPreferencesSchema = z.strictObject({
  local: z.boolean(),
  cloud: z.boolean(),
});
export const savingOf = (
  values: Pick<MapPreferences, "saveLocally" | "saveInCloud">,
): SavingPreferences => ({
  local: values.saveLocally,
  cloud: values.saveInCloud,
});
export const sameSaving = (a: SavingPreferences, b: SavingPreferences) =>
  a.local === b.local && a.cloud === b.cloud;

// The color settings edit the quick colors and the new-idea color together.
export const DEFAULT_COLOR_PREFERENCES: ColorPreferences = {
  quick: DEFAULT_PREFERENCES.quickColors,
  newIdeas: DEFAULT_PREFERENCES.newIdeaColor,
};
export const colorPreferences = (
  values: Pick<MapPreferences, "quickColors" | "newIdeaColor">,
): ColorPreferences => ({
  quick: values.quickColors,
  newIdeas: values.newIdeaColor,
});
export const sameQuickColors = (a: readonly Color[], b: readonly Color[]) =>
  a.length === b.length && a.every((color, index) => color === b[index]);

// Only white and shades can be chosen, as the shared core requires.
export const PickableColorSchema = z.custom<Color>(
  (value) => isNodeColor(value) && isPickable(value),
  "Invalid color choice.",
);
export const QuickColorsSchema = z
  .array(PickableColorSchema)
  .refine(
    (quick) => new Set(quick).size === quick.length,
    "Quick colors must be unique.",
  );
export const LinkStyleSchema = z.enum(["freeform", "rounded", "square"]);
export const AnalyticsConsentSchema = z.enum(["granted", "denied"]);
const VALUE_SCHEMAS = {
  quickColors: QuickColorsSchema,
  newIdeaColor: PickableColorSchema,
  linkStyle: LinkStyleSchema,
  saveLocally: z.boolean(),
  saveInCloud: z.boolean(),
  analyticsConsent: AnalyticsConsentSchema,
} satisfies Record<PreferenceName, z.ZodType>;

function parseValue<Name extends PreferenceName>(
  name: Name,
  value: unknown,
): PreferenceValues[Name] | undefined {
  const parsed = VALUE_SCHEMAS[name].safeParse(value);
  return parsed.success ? (parsed.data as PreferenceValues[Name]) : undefined;
}

const RowSchema = z.object({
  scope: z.enum(["global", "map"]),
  projectId: z.string().min(1).nullable(),
  name: z.enum(PREFERENCE_NAMES),
  value: z.unknown(),
});

// A row from the cloud or a backup, or nothing when it is not one this
// version understands.
export function parsePreferenceRow(value: unknown): PreferenceRow | undefined {
  const row = RowSchema.safeParse(value);
  if (!row.success) return;
  const { scope, projectId, name } = row.data;
  if ((scope === "map") !== (projectId !== null)) return;
  if (scope === "map" && !perMap(name)) return;
  const parsed = parseValue(name, row.data.value);
  if (parsed === undefined) return;
  return { scope, projectId, name, value: parsed } as PreferenceRow;
}

export function preferenceRow<Name extends PreferenceName>(
  scope: PreferenceScope,
  projectId: string | null,
  name: Name,
  value: PreferenceValues[Name],
) {
  return { scope, projectId, name, value } as PreferenceRow;
}

// The rows that set every value of `level`.
export function levelRows(
  scope: PreferenceScope,
  projectId: string | null,
  level: PreferenceLevel,
) {
  return PREFERENCE_NAMES.flatMap((name) => {
    const value = level[name];
    return value === undefined
      ? []
      : [preferenceRow(scope, projectId, name, value)];
  });
}

// The levels a map sees once `changes` are stored, to show them at once.
export function applyPreferenceChanges(
  levels: PreferenceLevels,
  projectId: string,
  { set = [], clear = [] }: PreferenceChanges,
): PreferenceLevels {
  const next = { global: { ...levels.global }, map: { ...levels.map } };
  const level = (target: PreferenceTarget) =>
    target.scope === "global"
      ? next.global
      : target.projectId === projectId
        ? next.map
        : undefined;
  for (const target of clear) {
    const values = level(target);
    if (values) delete values[target.name];
  }
  for (const row of set) {
    const values = level(row);
    if (values) Object.assign(values, { [row.name]: row.value });
  }
  return next;
}

// What an older map kept in its document, as values of its own.
export function legacyLevel(legacy?: LegacyPreferences): PreferenceLevel {
  return {
    ...(legacy?.colors && {
      quickColors: legacy.colors.quick,
      newIdeaColor: legacy.colors.newIdeas,
    }),
    ...(legacy?.links && { linkStyle: legacy.links }),
  };
}

// Stored under `preference/global/<name>` and `preference/map/<id>/<name>`.
// A map's stay stored while the map itself is kept in memory only, so its
// choice to stay out of this browser outlives the tab.
const PREFIX = "preference/";
export function preferenceKey(target: PreferenceTarget) {
  return target.scope === "global"
    ? `${PREFIX}global/${target.name}`
    : `${PREFIX}map/${target.projectId}/${target.name}`;
}
const isName = (name: string): name is PreferenceName =>
  (PREFERENCE_NAMES as readonly string[]).includes(name);
function targetOfKey(key: string): PreferenceTarget | undefined {
  const parts = key.split("/");
  if (parts[0] !== "preference") return;
  if (parts.length === 3 && parts[1] === "global" && isName(parts[2]))
    return { scope: "global", projectId: null, name: parts[2] };
  if (parts.length === 4 && parts[1] === "map" && isName(parts[3]))
    return { scope: "map", projectId: parts[2], name: parts[3] };
}
const targetOfRow = ({ scope, projectId, name }: PreferenceRow) => ({
  scope,
  projectId,
  name,
});

// One stored preference. A null value is a cleared one, kept only until the
// cloud has cleared it too. `pending` marks a change the cloud has not saved.
interface Stored {
  value: unknown;
  pending?: string;
}
const StoredSchema = z.object({
  value: z.unknown(),
  pending: z.string().optional(),
});
function stored(value: unknown): Stored | undefined {
  const parsed = StoredSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// Changes sent at once: within the cloud's request size even when each holds
// every color.
const CHANGES_PER_REQUEST = 100;

// Where a store keeps its preferences: the repository's browser storage.
export interface PreferenceStorage {
  read(key: string): Promise<unknown>;
  // `change` decides the next value from the stored one; undefined deletes it.
  update(key: string, change: (value: unknown) => unknown): Promise<unknown>;
  list(prefix: string): Promise<[string, unknown][]>;
}

export class PreferenceStore {
  readonly storage: PreferenceStorage;
  // An account's store marks its changes until the cloud has them.
  readonly synced: boolean;
  readonly #onChange?: () => unknown;
  // Names the browser lock that keeps tabs sharing this storage from syncing
  // at once.
  readonly #lock?: string;

  constructor(
    storage: PreferenceStorage,
    {
      synced = false,
      onChange,
      lock,
    }: { synced?: boolean; onChange?: () => unknown; lock?: string } = {},
  ) {
    this.storage = storage;
    this.synced = synced;
    this.#onChange = onChange;
    this.#lock = lock;
  }

  async #read<Name extends PreferenceName>(target: PreferenceTarget) {
    const value = stored(await this.storage.read(preferenceKey(target)))?.value;
    if (value === null || value === undefined) return;
    return parseValue(target.name as Name, value);
  }

  // The values set for all maps and, given a map, for that map.
  async levels(projectId?: string): Promise<PreferenceLevels> {
    const levels: PreferenceLevels = { global: {}, map: {} };
    for (const name of PREFERENCE_NAMES) {
      const global = await this.#read({
        scope: "global",
        projectId: null,
        name,
      });
      if (global !== undefined)
        Object.assign(levels.global, { [name]: global });
      if (!projectId || !perMap(name)) continue;
      const own = await this.#read({ scope: "map", projectId, name });
      if (own !== undefined) Object.assign(levels.map, { [name]: own });
    }
    return levels;
  }

  // What every map uses, read at once: the result resolves any map's.
  async resolver() {
    const global: PreferenceLevel = {};
    const maps = new Map<string, PreferenceLevel>();
    for (const [key, value] of await this.storage.list(PREFIX)) {
      const target = targetOfKey(key);
      const entry = stored(value)?.value;
      if (!target || entry === null || entry === undefined) continue;
      const parsed = parseValue(target.name, entry);
      if (parsed === undefined) continue;
      let level = global;
      if (target.projectId !== null) {
        level = maps.get(target.projectId) ?? {};
        maps.set(target.projectId, level);
      }
      Object.assign(level, { [target.name]: parsed });
    }
    return (projectId: string) =>
      resolvePreferences({ global, map: maps.get(projectId) ?? {} });
  }

  // Changes are stored at once, so they hold offline; a synced store marks
  // them for the cloud, which `sync` sends.
  async change({ set = [], clear = [] }: PreferenceChanges) {
    const pending = this.synced ? crypto.randomUUID() : undefined;
    for (const row of set)
      await this.storage.update(preferenceKey(row), () => ({
        value: row.value,
        ...(pending && { pending }),
      }));
    for (const target of clear)
      await this.storage.update(preferenceKey(target), () =>
        pending ? { value: null, pending } : undefined,
      );
    await this.#onChange?.();
  }

  // Sends the changes the cloud has not saved, then takes the cloud's values
  // for everything this browser has not changed since.
  // One tab syncs at a time: another's send could otherwise land after this
  // one's newer value, and its pull replace it here.
  async sync(api: LoroApi, signal: AbortSignal) {
    if (!this.synced) return;
    const locks = globalThis.navigator?.locks;
    if (!this.#lock || !locks) return this.#sync(api, signal);
    await locks.request(this.#lock, { signal }, () => this.#sync(api, signal));
  }

  async #sync(api: LoroApi, signal: AbortSignal) {
    const local = new Map<string, Stored & { target: PreferenceTarget }>();
    for (const [key, value] of await this.storage.list(PREFIX)) {
      const entry = stored(value);
      const target = targetOfKey(key);
      if (entry && target) local.set(key, { ...entry, target });
    }
    const pending = [...local].filter(([, entry]) => entry.pending);
    for (let start = 0; start < pending.length; start += CHANGES_PER_REQUEST) {
      const batch = pending.slice(start, start + CHANGES_PER_REQUEST);
      const set: PreferenceRow[] = [];
      const clear: PreferenceTarget[] = [];
      for (const [, { target, ...entry }] of batch) {
        if (entry.value === null) clear.push(target);
        else {
          const row = parsePreferenceRow({ ...target, value: entry.value });
          // A value this version cannot read is cleared rather than kept.
          if (row) set.push(row);
          else clear.push(target);
        }
      }
      await api.setPreferences({ set, clear }, signal);
      for (const [key, sent] of batch)
        await this.storage.update(key, (value) => {
          const current = stored(value);
          // A change made while this one was sending waits for the next sync.
          if (!current || current.pending !== sent.pending) return value;
          return current.value === null ? undefined : { value: current.value };
        });
    }
    signal.throwIfAborted();
    const remote = new Map(
      (await api.preferences(signal)).map((row) => [
        preferenceKey(targetOfRow(row)),
        row.value,
      ]),
    );
    signal.throwIfAborted();
    let changed = false;
    for (const [key, value] of remote)
      await this.storage.update(key, (previous) => {
        const current = stored(previous);
        if (current?.pending || (current && sameValue(current.value, value)))
          return previous;
        changed = true;
        return { value };
      });
    // Cleared elsewhere.
    for (const key of local.keys())
      if (!remote.has(key))
        await this.storage.update(key, (value) => {
          if (stored(value)?.pending) return value;
          changed = true;
          return undefined;
        });
    if (changed) await this.#onChange?.();
  }
}

// Syncs an account's preferences, then gives the account this browser's
// answer about analytics if a pull, just done, shows it has none. Offline, or
// while pulls fail, nothing is given: the cookie keeps deciding for this
// browser and the account keeps what it has.
export async function syncAccountPreferences(
  store: PreferenceStore,
  api: LoroApi,
  signal: AbortSignal,
  consent: AnalyticsConsent | "pending",
) {
  await store.sync(api, signal);
  if (consent === "pending" || (await store.levels()).global.analyticsConsent)
    return;
  await store.change({
    set: [preferenceRow("global", null, "analyticsConsent", consent)],
  });
  await store.sync(api, signal);
}

// Gives a copied map what its original used: what it set for itself, and
// each value it took from the preferences for all maps there that the ones
// where it goes would change, so it keeps its look and stays out of the cloud
// when it was. A copy made again replaces what an earlier one set.
export async function copyMapPreferences(
  from: PreferenceStore,
  fromId: string,
  to: PreferenceStore,
  toId: string,
) {
  const source = await from.levels(fromId);
  const used = resolvePreferences(source);
  const { global, map: earlier } = await to.levels(toId);
  const there = resolvePreferences({ global, map: {} });
  const own: PreferenceLevel = {};
  const clear: PreferenceTarget[] = [];
  for (const name of PREFERENCE_NAMES) {
    // Consent is the person's, never a map's.
    if (name === "analyticsConsent") continue;
    const value = source.map[name] ?? used[name];
    if (source.map[name] !== undefined || !sameValue(value, there[name]))
      Object.assign(own, { [name]: value });
    else if (earlier[name] !== undefined)
      clear.push({ scope: "map", projectId: toId, name });
  }
  await to.change({ set: levelRows("map", toId, own), clear });
}

// Moves what an older map kept in its document into its own preferences,
// unless it already has its own value, then forgets the document's copy.
export async function adoptLegacyPreferences(
  store: PreferenceStore,
  projectId: string,
  legacy: LegacyPreferences,
  forget: () => void,
) {
  const own = (await store.levels(projectId)).map;
  const set = levelRows("map", projectId, legacyLevel(legacy)).filter(
    (row) => own[row.name] === undefined,
  );
  if (set.length) await store.change({ set });
  forget();
}
