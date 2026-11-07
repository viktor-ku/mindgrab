import { makeEventListener } from "@solid-primitives/event-listener";
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
  // In the phone panel: a flat footer instead of a floating island.
  inline?: boolean;
  // A message already on screen elsewhere, which this section need not repeat.
  shownElsewhere?: string;
  onAuthError?: () => void;
}) {
  const [authError, setAuthError] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuButton: HTMLButtonElement | undefined;
  const navigation = createMutation(() => ({
    mutationKey: ["account", "navigation"],
    mutationFn: performNavigation,
    onMutate: () => setAuthError(""),
  }));
  const message = () =>
    navigation.isError
      ? "Could not save the account change in this browser. Free up browser storage and retry."
      : authError();
  const accountMessage = () => {
    const text = message() || props.state.message;
    return text === props.shownElsewhere ? "" : text;
  };
  const navigating = () => navigation.isPending;
  const navigate = (action: "login" | "logout") => {
    if (!navigating()) navigation.mutate(action);
  };
  onMount(() => {
    // Menus close on any press outside them, like native menus.
    makeEventListener(window, "pointerdown", (e) => {
      if (
        menuOpen() &&
        e.target instanceof Element &&
        !e.target.closest('[aria-label="Account"]')
      )
        setMenuOpen(false);
    });
    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth_error")) return;
    setAuthError(
      url.searchParams.get("auth_error") === "unavailable"
        ? "Sign-in is temporarily unavailable. Please try again."
        : "Sign-in did not complete. Please try again.",
    );
    props.onAuthError?.();
    url.searchParams.delete("auth_error");
    window.history.replaceState(window.history.state, "", url);
  });

  async function performNavigation(action: "login" | "logout") {
    if (!(await props.beforeNavigate(action))) return;
    // Account transitions can remove these controls before navigation.
    const form = document.createElement("form");
    form.method = "post";
    form.action = backendEndpoint(
      action === "login" ? "/api/startLogin.php" : "/api/logout.php",
    );
    form.hidden = true;
    document.body.append(form);
    form.submit();
  }

  // With only the sign-in button to show, the button is the island itself.
  const bare = () =>
    props.state.status !== "authenticated" &&
    props.state.status !== "checking" &&
    props.state.status !== "unavailable" &&
    props.state.status !== "expired" &&
    !message() &&
    !props.state.message &&
    !props.claimMessage;
  return (
    <section
      data-no-pan
      data-toolbar
      class={
        props.inline
          ? "panel-account flex flex-col gap-1 text-sm"
          : "pointer-events-auto relative flex max-w-72 flex-col gap-1 text-sm cursor-default"
      }
      classList={{ "map-toolbar": !bare() && !props.inline }}
      aria-label="Account"
    >
      <div class="flex min-h-9 items-center gap-1">
        <Show when={props.state.user}>
          {(user) => {
            const name = () => user().name || user().email || "Cached account";
            const avatar = (
              <span
                aria-hidden="true"
                class="grid size-7 shrink-0 place-items-center rounded-full bg-stone-800 text-xs font-semibold text-white"
              >
                {(user().name || user().email || "?")
                  .trim()
                  .charAt(0)
                  .toUpperCase()}
              </span>
            );
            const identity = () => (
              <>
                <p class="truncate text-sm font-medium text-stone-800">
                  {name()}
                </p>
                <Show when={user().email && user().email !== name()}>
                  <p class="truncate text-xs text-stone-500">{user().email}</p>
                </Show>
              </>
            );
            if (props.inline)
              return (
                <>
                  <span class="flex">{avatar}</span>
                  <div class="min-w-0 flex-1 px-1">{identity()}</div>
                  <Show when={props.state.status === "authenticated"}>
                    <button
                      type="button"
                      class="map-control text-xs"
                      disabled={navigating() || props.claiming}
                      onClick={() => navigate("logout")}
                    >
                      Sign out
                    </button>
                  </Show>
                </>
              );
            return (
              <Show
                when={props.state.status === "authenticated"}
                fallback={
                  <>
                    <span class="ml-1 flex">{avatar}</span>
                    <span
                      class="min-w-0 max-w-36 truncate px-1 text-stone-700"
                      title={user().email}
                    >
                      {name()}
                    </span>
                  </>
                }
              >
                <button
                  ref={menuButton}
                  type="button"
                  class="icon-button"
                  title={name()}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen()}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  {avatar}
                  <span class="sr-only">{name()}</span>
                </button>
                <Show when={menuOpen()}>
                  <div
                    role="menu"
                    aria-label="Account menu"
                    class="map-toolbar menu-panel absolute top-full right-0 mt-2 w-60 cursor-default"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuOpen(false);
                        menuButton?.focus();
                      }
                    }}
                    onFocusOut={(e) => {
                      // Tabbing out of the menu closes it, like a native menu.
                      const next = e.relatedTarget;
                      if (
                        next instanceof Element &&
                        !next.closest('[aria-label="Account"]')
                      )
                        setMenuOpen(false);
                    }}
                  >
                    <div class="px-2.5 py-1.5">{identity()}</div>
                    <div class="menu-divider" />
                    <button
                      ref={(item) => queueMicrotask(() => item.focus())}
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      disabled={navigating() || props.claiming}
                      onClick={() => {
                        setMenuOpen(false);
                        navigate("logout");
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                </Show>
              </Show>
            );
          }}
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
            class={
              props.inline
                ? `primary-button ${props.state.user ? "shrink-0 px-3! py-1.5! text-xs!" : "w-full"}`
                : bare()
                  ? "primary-button account-signin"
                  : "primary-button px-3! py-1.5! text-xs!"
            }
            disabled={navigating() || props.claiming}
            onClick={() => void navigate("login")}
          >
            {props.state.user ? "Sign in again" : "Sign in"}
          </button>
        </Show>
      </div>
      <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
        {accountMessage()}
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
