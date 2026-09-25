import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { backendEndpoint } from "./backend";

export type User = {
  id: number;
  name: string;
  email: string;
  external_id: string;
};

export function AccountControls(props: {
  beforeNavigate: () => boolean;
  onUser: (user: User | undefined) => void;
}) {
  const [user, setUser] = createSignal<User>();
  const [loading, setLoading] = createSignal(true);
  const [message, setMessage] = createSignal("");
  const [failed, setFailed] = createSignal(false);
  let checking = false;
  let disposed = false;

  async function checkSession() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(backendEndpoint("/api/me"), {
        credentials: "include",
        cache: "no-store",
      });
      if (response.status !== 401 && !response.ok) throw new Error();
      const current =
        response.status === 401 ? undefined : await response.json();
      if (disposed) return;
      setUser(current);
      props.onUser(current);
      if (failed()) setMessage("");
      setFailed(false);
    } catch {
      if (disposed) return;
      setFailed(true);
      setMessage("Could not check your account. Please retry.");
    } finally {
      checking = false;
      if (!disposed) setLoading(false);
    }
  }

  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("auth_error")) {
      setMessage(
        url.searchParams.get("auth_error") === "unavailable"
          ? "Sign-in is temporarily unavailable. Please try again."
          : "Sign-in did not complete. Please try again.",
      );
      url.searchParams.delete("auth_error");
      window.history.replaceState(window.history.state, "", url);
    }
    void checkSession();
    const refresh = () => void checkSession();
    window.addEventListener("focus", refresh);
    onCleanup(() => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    });
  });

  return (
    <div class="mt-1 border-t border-stone-200 pt-1 text-sm">
      <Show
        when={!loading()}
        fallback={
          <p role="status" class="px-2 py-2 text-xs text-stone-500">
            Checking account…
          </p>
        }
      >
        <Show
          when={user()}
          fallback={
            <a
              class="map-control block"
              href={backendEndpoint("/api/auth/login")}
              onClick={(event) => {
                if (!props.beforeNavigate()) event.preventDefault();
              }}
            >
              Sign in
            </a>
          }
        >
          {(current) => (
            <div class="flex items-center gap-1">
              <span
                class="min-w-0 flex-1 truncate px-2"
                title={current().email}
              >
                {current().name || current().email}
              </span>
              <form
                method="post"
                action={backendEndpoint("/api/auth/logout")}
                onSubmit={(event) => {
                  if (!props.beforeNavigate()) event.preventDefault();
                }}
              >
                <button type="submit" class="map-control">
                  Sign out
                </button>
              </form>
            </div>
          )}
        </Show>
      </Show>
      <p role="status" class="px-2 text-xs text-stone-600 empty:hidden">
        {message()}
      </p>
      <Show when={failed()}>
        <button
          type="button"
          class="map-control text-xs"
          onClick={() => void checkSession()}
        >
          Retry
        </button>
      </Show>
    </div>
  );
}
