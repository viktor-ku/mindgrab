import { createSignal, onMount, Show } from "solid-js";
import { backendEndpoint } from "./backend";
import type { SessionState } from "./auth-session";

export function AccountControls(props: {
  state: SessionState;
  beforeNavigate: (action: "login" | "logout") => boolean | Promise<boolean>;
  onRetry: () => void;
  claimCount: number;
  claiming: boolean;
  claimMessage: string;
  onClaim: () => void;
}) {
  const [message, setMessage] = createSignal("");
  const [navigating, setNavigating] = createSignal(false);
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

  async function navigate(action: "login" | "logout") {
    if (navigating()) return;
    setNavigating(true);
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
    } finally {
      setNavigating(false);
    }
  }

  return (
    <section
      class="mt-1 border-t border-stone-200 pt-1 text-sm"
      aria-label="Account"
    >
      <Show when={props.state.user}>
        {(user) => (
          <div class="flex items-center gap-1">
            <span class="min-w-0 flex-1 truncate px-2" title={user().email}>
              {user().name || user().email || "Cached account"}
            </span>
            <button
              type="button"
              class="map-control"
              disabled={navigating() || props.claiming}
              onClick={() => void navigate("logout")}
            >
              Sign out
            </button>
          </div>
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
          class="map-control block"
          disabled={navigating() || props.claiming}
          onClick={() => void navigate("login")}
        >
          {props.state.user ? "Sign in again" : "Sign in"}
        </button>
      </Show>
      <Show
        when={props.state.status === "authenticated" && props.claimCount > 0}
      >
        <div class="px-2 py-1 text-xs">
          <p>
            {props.claimCount} anonymous{" "}
            {props.claimCount === 1 ? "project is" : "projects are"} saved
            separately in this browser.
          </p>
          <button
            type="button"
            class="map-control mt-1"
            disabled={props.claiming || navigating()}
            onClick={props.onClaim}
          >
            {props.claiming
              ? "Adding projects…"
              : "Add anonymous projects to this account"}
          </button>
        </div>
      </Show>
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
