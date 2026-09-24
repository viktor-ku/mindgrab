import { getRouteApi, Link, useRouter } from "@tanstack/solid-router";
import type { JSX } from "solid-js";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { formatLatency, overallStatus } from "./health";
import type { ComponentHealth, ComponentState, Overall } from "./health";

const routeApi = getRouteApi("/checkhealth");
const REFRESH_MS = 15_000;

type DotTone = ComponentState | "degraded";

const dotTone: Record<DotTone, { dot: string; ping?: string }> = {
  up: { dot: "bg-emerald-500", ping: "bg-emerald-400" },
  down: { dot: "bg-rose-500", ping: "bg-rose-400" },
  degraded: { dot: "bg-amber-500", ping: "bg-amber-400" },
  unknown: { dot: "bg-stone-300" },
};

const componentTone: Record<ComponentState, { text: string; label: string }> = {
  up: { text: "text-emerald-700", label: "Operational" },
  down: { text: "text-rose-700", label: "Unreachable" },
  unknown: { text: "text-stone-500", label: "Not checked" },
};

const overallTone: Record<
  Overall,
  { title: string; body: string; panel: string; dot: DotTone }
> = {
  operational: {
    title: "All systems operational",
    body: "The API and database are responding normally.",
    panel: "bg-emerald-50 text-emerald-950 ring-emerald-200",
    dot: "up",
  },
  degraded: {
    title: "Database unreachable",
    body: "The API is responding but cannot reach the database.",
    panel: "bg-amber-50 text-amber-950 ring-amber-200",
    dot: "degraded",
  },
  outage: {
    title: "API unreachable",
    body: "The server did not respond. Check your connection or try again shortly.",
    panel: "bg-rose-50 text-rose-950 ring-rose-200",
    dot: "down",
  },
};

function StatusDot(props: { state: DotTone; large?: boolean }) {
  const tone = () => dotTone[props.state];
  return (
    <span
      aria-hidden="true"
      class="relative flex shrink-0"
      classList={{ "size-3": !props.large, "size-4": props.large }}
    >
      <Show when={tone().ping}>
        {(ping) => (
          <span
            class={`absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping ${ping()}`}
          />
        )}
      </Show>
      <span
        class={`relative inline-flex size-full rounded-full ${tone().dot}`}
      />
    </span>
  );
}

function ComponentRow(props: {
  name: string;
  metric: string;
  health: ComponentHealth;
}) {
  const tone = () => componentTone[props.health.state];
  return (
    <li class="flex items-center gap-4 px-5 py-4">
      <StatusDot state={props.health.state} />
      <div class="min-w-0 flex-1">
        <p class="font-medium text-stone-900">{props.name}</p>
        <p class={`text-sm ${tone().text}`}>{tone().label}</p>
      </div>
      <div class="text-right">
        <p class="font-mono text-sm text-stone-900 tabular-nums">
          {formatLatency(props.health.latencyMs)}
        </p>
        <p class="text-xs text-stone-500">{props.metric}</p>
      </div>
    </li>
  );
}

function StatusLayout(props: { children: JSX.Element }) {
  onMount(() => {
    const previous = document.title;
    document.title = "Status · mindgrab";
    onCleanup(() => {
      document.title = previous;
    });
  });
  return (
    <main class="min-h-screen bg-stone-100 px-4 py-12 text-stone-900 sm:py-20">
      <div class="mx-auto max-w-lg">
        <header class="mb-6 flex items-baseline justify-between">
          <Link
            to="/"
            class="rounded text-sm font-semibold tracking-tight text-stone-900 hover:text-stone-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            mindgrab
          </Link>
          <span class="text-xs font-medium tracking-widest text-stone-500 uppercase">
            System status
          </span>
        </header>
        {props.children}
      </div>
    </main>
  );
}

export function CheckHealthPending() {
  return (
    <StatusLayout>
      <section
        role="status"
        class="rounded-2xl bg-white p-6 ring-1 ring-stone-200"
      >
        <div class="flex items-center gap-3">
          <StatusDot state="unknown" large />
          <p class="font-semibold">Checking status…</p>
        </div>
      </section>
    </StatusLayout>
  );
}

export function CheckHealth() {
  const report = routeApi.useLoaderData();
  const router = useRouter();
  const [refreshing, setRefreshing] = createSignal(false);
  const overall = () => overallTone[overallStatus(report())];

  async function refresh() {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  }

  onMount(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });

  return (
    <StatusLayout>
      <section
        role="status"
        aria-live="polite"
        class={`rounded-2xl p-6 ring-1 ${overall().panel}`}
      >
        <div class="flex items-center gap-3">
          <StatusDot state={overall().dot} large />
          <h1 class="text-lg font-semibold tracking-tight">
            {overall().title}
          </h1>
        </div>
        <p class="mt-2 pl-7 text-sm opacity-80">{overall().body}</p>
      </section>

      <ul class="mt-4 divide-y divide-stone-100 rounded-2xl bg-white shadow-sm ring-1 ring-stone-200">
        <ComponentRow
          name="API server"
          metric="round trip"
          health={report().server}
        />
        <ComponentRow
          name="Database"
          metric="query time"
          health={report().database}
        />
      </ul>

      <footer class="mt-4 flex items-center justify-between gap-4 px-1 text-xs text-stone-500">
        <span>
          Checked at{" "}
          <time datetime={new Date(report().checkedAt).toISOString()}>
            {new Date(report().checkedAt).toLocaleTimeString()}
          </time>{" "}
          · refreshes every {REFRESH_MS / 1000}s
        </span>
        <button
          type="button"
          class="map-control border border-stone-200 bg-white text-stone-700"
          disabled={refreshing()}
          onClick={() => void refresh()}
        >
          {refreshing() ? "Checking…" : "Refresh"}
        </button>
      </footer>
    </StatusLayout>
  );
}
