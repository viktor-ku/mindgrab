import { expect, test } from "bun:test";
import type { LoroApi } from "../src/loro-api";
import {
  adoptLegacyPreferences,
  applyPreferenceChanges,
  copyMapPreferences,
  DEFAULT_PREFERENCES,
  parsePreferenceRow,
  PreferenceStore,
  preferenceKey,
  preferenceRow,
  resolvePreferences,
  savingOf,
} from "../src/preferences";
import type {
  PreferenceChanges,
  PreferenceRow,
  PreferenceTarget,
} from "../src/preferences";
import type { PreferenceStorage } from "../src/preferences";

// One browser's storage for a repository's preferences.
class Storage implements PreferenceStorage {
  values = new Map<string, unknown>();
  async read(key: string) {
    return this.values.get(key);
  }
  async update(key: string, change: (value: unknown) => unknown) {
    const next = change(this.values.get(key));
    if (next === undefined) this.values.delete(key);
    else this.values.set(key, next);
    return next;
  }
  async list(prefix: string): Promise<[string, unknown][]> {
    return [...this.values].filter(([key]) => key.startsWith(prefix));
  }
}
const local = (storage = new Storage()) => new PreferenceStore(storage);
const synced = (storage = new Storage(), onChange?: () => unknown) =>
  new PreferenceStore(storage, { synced: true, onChange });

// The account's preferences in the cloud.
class Cloud {
  rows = new Map<string, PreferenceRow>();
  sent: PreferenceChanges[] = [];
  offline = false;
  // Runs while a change is being sent, as another tab could.
  whileSending?: () => Promise<void>;
  async setPreferences({ set = [], clear = [] }: PreferenceChanges) {
    if (this.offline) throw new Error("offline");
    this.sent.push({ set, clear });
    await this.whileSending?.();
    for (const target of clear) this.rows.delete(preferenceKey(target));
    for (const row of set) this.rows.set(preferenceKey(row), row);
  }
  async preferences() {
    if (this.offline) throw new Error("offline");
    return [...this.rows.values()];
  }
}
const api = (cloud: Cloud) => cloud as unknown as LoroApi;
const signal = () => new AbortController().signal;
const MAP = "6f1c2a1e-3b0a-4c55-9a6e-2f2c3c0f9b11";
const target = (
  scope: PreferenceTarget["scope"],
  name: PreferenceTarget["name"],
): PreferenceTarget => ({
  scope,
  projectId: scope === "map" ? MAP : null,
  name,
});

test("a map's own value wins over the one for all maps, then the default", () => {
  expect(resolvePreferences()).toEqual(DEFAULT_PREFERENCES);
  const levels = {
    global: { linkStyle: "square" as const, newIdeaColor: "sky-200" as const },
    map: { linkStyle: "freeform" as const },
  };
  expect(resolvePreferences(levels)).toEqual({
    ...DEFAULT_PREFERENCES,
    linkStyle: "freeform",
    newIdeaColor: "sky-200",
  });
  // Changes show at once for the map they concern, and for all maps.
  const next = applyPreferenceChanges(levels, MAP, {
    set: [
      preferenceRow("global", null, "quickColors", ["slate"]),
      preferenceRow("map", "another map", "linkStyle", "square"),
    ],
    clear: [target("map", "linkStyle")],
  });
  expect(next).toEqual({
    global: { ...levels.global, quickColors: ["slate"] },
    map: {},
  });
  expect(levels.map).toEqual({ linkStyle: "freeform" });
});

test("rows are checked against their name and scope", () => {
  const row = { scope: "map", projectId: MAP, name: "linkStyle" };
  expect(parsePreferenceRow({ ...row, value: "square" })).toEqual({
    ...row,
    value: "square",
  } as PreferenceRow);
  for (const value of [
    { ...row, value: "zigzag" },
    { ...row, projectId: null, value: "square" },
    { ...row, scope: "global", value: "square" },
    { ...row, scope: "folder", value: "square" },
    { ...row, name: "quickColors", value: ["slate", "slate"] },
    { ...row, name: "newIdeaColor", value: "teal" },
    { ...row, name: "fontSize", value: 12 },
  ])
    expect(parsePreferenceRow(value)).toBeUndefined();
});

test("signed out, preferences stay in this browser", async () => {
  const storage = new Storage();
  const store = local(storage);
  await store.change({
    set: [
      preferenceRow("global", null, "linkStyle", "square"),
      preferenceRow("map", MAP, "linkStyle", "freeform"),
    ],
  });
  expect(await store.levels(MAP)).toEqual({
    global: { linkStyle: "square" },
    map: { linkStyle: "freeform" },
  });
  // Only the values are kept: nothing waits for a cloud.
  expect(storage.values.get(preferenceKey(target("map", "linkStyle")))).toEqual(
    { value: "freeform" },
  );
  await store.change({ clear: [target("map", "linkStyle")] });
  expect(await store.levels(MAP)).toEqual({
    global: { linkStyle: "square" },
    map: {},
  });
  expect(storage.values.size).toBe(1);
  await store.sync(api(new Cloud()), signal());
});

test("signed in, changes hold offline and reach the cloud, which brings others' changes back", async () => {
  const storage = new Storage();
  const cloud = new Cloud();
  const store = synced(storage);
  // Set elsewhere: on another device, or since cleared there.
  cloud.rows.set(
    preferenceKey(target("global", "newIdeaColor")),
    preferenceRow("global", null, "newIdeaColor", "sky-200"),
  );
  storage.values.set(preferenceKey(target("global", "quickColors")), {
    value: ["slate"],
  });
  cloud.offline = true;
  await store.change({
    set: [preferenceRow("map", MAP, "linkStyle", "square")],
    clear: [target("global", "linkStyle")],
  });
  await expect(store.sync(api(cloud), signal())).rejects.toThrow("offline");
  expect((await store.levels(MAP)).map).toEqual({ linkStyle: "square" });

  cloud.offline = false;
  await store.sync(api(cloud), signal());
  expect(cloud.sent).toEqual([
    {
      set: [preferenceRow("map", MAP, "linkStyle", "square")],
      clear: [target("global", "linkStyle")],
    },
  ]);
  expect(await store.levels(MAP)).toEqual({
    global: { newIdeaColor: "sky-200" },
    map: { linkStyle: "square" },
  });
  // Sent changes are no longer marked, and the cleared one is gone.
  expect(Object.fromEntries(storage.values)).toEqual({
    [preferenceKey(target("map", "linkStyle"))]: { value: "square" },
    [preferenceKey(target("global", "newIdeaColor"))]: { value: "sky-200" },
  });
  await store.sync(api(cloud), signal());
  expect(cloud.sent).toHaveLength(1);
});

test("a change made while another is sent waits for the next sync", async () => {
  const storage = new Storage();
  const cloud = new Cloud();
  const store = synced(storage);
  await store.change({
    set: [preferenceRow("map", MAP, "linkStyle", "square")],
  });
  cloud.whileSending = async () => {
    cloud.whileSending = undefined;
    await store.change({
      set: [preferenceRow("map", MAP, "linkStyle", "freeform")],
    });
  };
  await store.sync(api(cloud), signal());
  // The cloud still has the older value; this browser keeps the newer one.
  expect(cloud.rows.get(preferenceKey(target("map", "linkStyle")))?.value).toBe(
    "square",
  );
  expect((await store.levels(MAP)).map.linkStyle).toBe("freeform");
  await store.sync(api(cloud), signal());
  expect(cloud.rows.get(preferenceKey(target("map", "linkStyle")))?.value).toBe(
    "freeform",
  );
});

test("an older map's colors become its own, unless it already has them", async () => {
  const store = local();
  await store.change({
    set: [preferenceRow("map", MAP, "linkStyle", "freeform")],
  });
  let forgotten = 0;
  await adoptLegacyPreferences(
    store,
    MAP,
    { colors: { quick: ["sky-400"], newIdeas: "lime-200" }, links: "square" },
    () => forgotten++,
  );
  expect(forgotten).toBe(1);
  expect((await store.levels(MAP)).map).toEqual({
    quickColors: ["sky-400"],
    newIdeaColor: "lime-200",
    linkStyle: "freeform",
  });
});

test("a copied map keeps what it used, even from the preferences for all maps", async () => {
  const from = local();
  const cloud = new Cloud();
  const to = synced();
  await from.change({
    set: [
      preferenceRow("global", null, "linkStyle", "square"),
      preferenceRow("global", null, "saveInCloud", false),
      preferenceRow("global", null, "newIdeaColor", "sky-200"),
      preferenceRow("global", null, "analyticsConsent", "granted"),
      preferenceRow("map", MAP, "quickColors", ["slate", "sky-400"]),
      preferenceRow("map", MAP, "linkStyle", "rounded"),
    ],
  });
  // Where it goes, new ideas already start sky-200.
  await to.change({
    set: [preferenceRow("global", null, "newIdeaColor", "sky-200")],
  });
  await copyMapPreferences(from, MAP, to, "copy");
  expect((await to.levels("copy")).map).toEqual({
    quickColors: ["slate", "sky-400"],
    linkStyle: "rounded",
    saveInCloud: false,
  });
  expect(savingOf(resolvePreferences(await to.levels("copy")))).toEqual({
    local: true,
    cloud: false,
  });
  await to.sync(api(cloud), signal());
  expect([...cloud.rows.values()]).toContainEqual(
    preferenceRow("map", "copy", "saveInCloud", false),
  );
});

test("where each map is kept resolves from one read, and consent is never a map's", async () => {
  const store = local();
  await store.change({
    set: [
      preferenceRow("global", null, "saveInCloud", false),
      preferenceRow("map", MAP, "saveInCloud", true),
      preferenceRow("map", MAP, "saveLocally", false),
      preferenceRow("global", null, "analyticsConsent", "granted"),
    ],
  });
  const resolve = await store.resolver();
  expect(savingOf(resolve(MAP))).toEqual({ local: false, cloud: true });
  expect(savingOf(resolve("another map"))).toEqual({
    local: true,
    cloud: false,
  });
  // The answer about analytics is the person's, not part of what a map uses.
  expect(resolve(MAP)).not.toHaveProperty("analyticsConsent");
  expect((await store.levels(MAP)).global.analyticsConsent).toBe("granted");
  expect(
    parsePreferenceRow({
      scope: "map",
      projectId: MAP,
      name: "analyticsConsent",
      value: "granted",
    }),
  ).toBeUndefined();
});

test("changes and what a sync brings in are announced", async () => {
  let announced = 0;
  const cloud = new Cloud();
  const store = synced(new Storage(), () => announced++);
  await store.change({
    set: [preferenceRow("global", null, "saveLocally", false)],
  });
  expect(announced).toBe(1);
  // Sending what changed here brings nothing new.
  await store.sync(api(cloud), signal());
  expect(announced).toBe(1);
  cloud.rows.set(
    preferenceKey(target("global", "saveInCloud")),
    preferenceRow("global", null, "saveInCloud", false),
  );
  await store.sync(api(cloud), signal());
  expect(announced).toBe(2);
});

test("a copy made again drops what the original no longer sets", async () => {
  const from = local();
  const to = synced();
  await from.change({
    set: [preferenceRow("map", MAP, "linkStyle", "square")],
  });
  await copyMapPreferences(from, MAP, to, "copy");
  expect((await to.levels("copy")).map.linkStyle).toBe("square");
  // The first copy did not finish, and the map went back to the style for all
  // maps before the next one.
  await from.change({ clear: [target("map", "linkStyle")] });
  await copyMapPreferences(from, MAP, to, "copy");
  expect((await to.levels("copy")).map).toEqual({});
});
