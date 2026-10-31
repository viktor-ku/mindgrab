import { createMutation } from "@tanstack/solid-query";
import { createSignal, onMount, Show } from "solid-js";
import { backendEndpoint } from "./backend";
import type { SessionState } from "./auth-session";

export function AccountControls(props: {
  state: SessionState;
  beforeNavigate: (action: "login" | "logout") => boolean | Promise<boolean>;
  onRetry: () => void;
  claiming: boolean;
  claimMessage: string;
}) {
  const [message, setMessage] = createSignal("");
  const navigation = createMutation(() => ({
    mutationKey: ["account", "navigation"],
    mutationFn: performNavigation,
  }));
  const navigating = () => navigation.isPending;
  const navigate = (action: "login" | "logout") => {
    if (!navigating()) navigation.mutate(action);
  };
  onMount(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth_error")) return;
    setMessage(
      url.searchParams.get("auth_error") === "unavailable"
        ? "Sign-in is temporarily unavailable. Please try again."
        : "Sign-in did not complete. Please try again.",
    );
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", url);
  });

  async function performNavigation(action: "login" | "logout") {
    setMessage("");
    try {
      if (!(await props.beforeNavigate(action))) return;
      // Account transitions can remove these controls before navigation.
      const form = document.createElement("form");
      form.method = "post";
      form.action = backendEndpoint(
        action === "login" ? "/api/startLogin" : "/api/logout",
      );
      form.hidden = true;
      document.body.append(form);
      form.submit();
    } catch {
      setMessage(
        "Could not save the account change in this browser. Free up browser storage and retry.",
      );
    }
  }

  return (
    <section
      data-no-pan
      data-toolbar
      class="map-toolbar pointer-events-auto flex max-w-72 flex-col gap-1 text-sm cursor-default"
      aria-label="Account"
    >
      <div class="flex min-h-9 items-center gap-1">
        <Show when={props.state.user}>
          {(user) => (
            <>
              <span
                aria-hidden="true"
                class="ml-1 grid size-7 shrink-0 place-items-center rounded-full bg-stone-800 text-xs font-semibold text-white"
              >
                {(user().name || user().email || "?")
                  .trim()
                  .charAt(0)
                  .toUpperCase()}
              </span>
              <span
                class="min-w-0 max-w-36 truncate px-1 text-stone-700"
                title={user().email}
              >
                {user().name || user().email || "Cached account"}
              </span>
              <Show when={props.state.status === "authenticated"}>
                <button
                  type="button"
                  class="map-control text-xs! text-stone-500"
                  disabled={navigating() || props.claiming}
                  onClick={() => void navigate("logout")}
                >
                  Sign out
                </button>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.state.status === "checking"}>
          <p role="status" class="px-2 py-2 text-xs text-stone-500">
            Checking account…
          </p>
        </Show>
        <Show
          when={
            props.state.status !== "authenticated" &&
            props.state.status !== "checking"
          }
        >
          <button
            type="button"
            class="primary-button px-3! py-1.5! text-xs!"
            disabled={navigating() || props.claiming}
            onClick={() => void navigate("login")}
          >
            {props.state.user ? "Sign in again" : "Sign in"}
          </button>
        </Show>
      </div>
      <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
        {message() || props.state.message}
      </p>
      <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
        {props.claimMessage}
      </p>
      <Show
        when={
          props.state.status === "unavailable" ||
          props.state.status === "expired"
        }
      >
        <button
          type="button"
          class="map-control text-xs"
          onClick={props.onRetry}
        >
          Check account again
        </button>
      </Show>
    </section>
  );
}
