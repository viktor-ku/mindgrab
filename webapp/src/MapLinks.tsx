import { createMemo, For, Show } from "solid-js";
import type { Connection, LinkStyle } from "./mind-map";
import { connectionParts } from "./mind-map";
import { lineLook } from "./node-colors";
import type { NodeColor } from "./node-colors";

// The lines from ideas to their children. A tree's trunks and spines are
// shared by siblings, so they draw neutral, under every arm; only each
// child's own arm takes its color. Keyed by child id so a layout change
// updates path data in place instead of recreating every line.
export function MapLinks(props: {
  ids: string[];
  connection: (id: string) => Connection | undefined;
  style?: LinkStyle;
  color: (connection: Connection) => NodeColor | undefined;
}) {
  const neutral = lineLook(undefined);
  const parts = (id: string) =>
    createMemo(() => {
      const connection = props.connection(id);
      return connection && connectionParts(connection, props.style);
    });
  return (
    <svg
      class="map-links absolute inset-0 w-full h-full overflow-visible pointer-events-none"
      aria-hidden="true"
    >
      <For each={props.ids}>
        {(id) => {
          const line = parts(id);
          return (
            <Show when={line()?.shared}>
              {(d) => (
                <path
                  d={d()}
                  fill="none"
                  class={neutral.class}
                  style={neutral.style}
                />
              )}
            </Show>
          );
        }}
      </For>
      <For each={props.ids}>
        {(id) => {
          const line = parts(id);
          const look = () => {
            const connection = props.connection(id);
            return lineLook(connection && props.color(connection));
          };
          return (
            <Show when={line()?.arm}>
              {(d) => (
                <path
                  d={d()}
                  fill="none"
                  class={look().class}
                  style={look().style}
                />
              )}
            </Show>
          );
        }}
      </For>
    </svg>
  );
}
