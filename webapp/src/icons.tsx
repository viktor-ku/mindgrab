import type { JSX } from "solid-js";

// Stroke icons drawn on a 20px grid. Each is decorative; the owning control
// supplies the accessible name.
function Icon(props: { children: JSX.Element; class?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class ?? "size-4.5"}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

type IconProps = { class?: string };

export const UndoIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M7.5 5 4 8.5 7.5 12" />
    <path d="M4.5 8.5h7a4.5 4.5 0 0 1 0 9H9" />
  </Icon>
);

export const RedoIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M12.5 5 16 8.5 12.5 12" />
    <path d="M15.5 8.5h-7a4.5 4.5 0 0 0 0 9H11" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <circle cx="8.75" cy="8.75" r="5.25" />
    <path d="m12.5 12.5 4 4" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="m6 8 4 4 4-4" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="m8 6 4 4-4 4" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M4.5 10h11" />
  </Icon>
);

export const FitMapIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" />
    <rect x="7" y="7.5" width="6" height="5" rx="1" />
  </Icon>
);

export const FitSelectionIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <circle cx="10" cy="10" r="2.25" />
    <path d="M10 2.75v2.5M10 14.75v2.5M2.75 10h2.5M14.75 10h2.5" />
    <circle cx="10" cy="10" r="5.75" />
  </Icon>
);

export const HelpIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <circle cx="10" cy="10" r="7" />
    <path d="M8 8a2 2 0 1 1 2.75 1.85c-.5.2-.75.6-.75 1.15v.5" />
    <path d="M10 14h.01" stroke-width="2.2" />
  </Icon>
);

export const ChildIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <rect x="2.75" y="3.5" width="6" height="4.5" rx="1" />
    <rect x="11.25" y="12" width="6" height="4.5" rx="1" />
    <path d="M5.75 8v3.25a3 3 0 0 0 3 3h2.5" />
  </Icon>
);

export const SiblingIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <rect x="7" y="3" width="8.5" height="4.5" rx="1" />
    <rect x="7" y="12.5" width="8.5" height="4.5" rx="1" />
    <path d="M3.5 5.25v9.5h3.5M3.5 5.25H7" />
  </Icon>
);

export const FoldIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="m6 7 4-3.5L14 7M6 13l4 3.5 4-3.5" />
  </Icon>
);

export const UnfoldIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="m6 3.5 4 3.5 4-3.5M6 16.5l4-3.5 4 3.5" />
  </Icon>
);

export const FocusIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M3.5 7V4.5a1 1 0 0 1 1-1H7M13 3.5h2.5a1 1 0 0 1 1 1V7M16.5 13v2.5a1 1 0 0 1-1 1H13M7 16.5H4.5a1 1 0 0 1-1-1V13" />
    <circle cx="10" cy="10" r="2.5" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M4 6h12M8 6V4.5h4V6M5.5 6l.75 10h7.5l.75-10" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M5 10h.01M10 10h.01M15 10h.01" stroke-width="2.6" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
  </Icon>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M9 5 4 10l5 5M4.5 10h11" />
  </Icon>
);

export const BrandMark = (props: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    class={props.class ?? "size-6"}
    aria-hidden="true"
    fill="none"
  >
    <rect width="24" height="24" rx="7" fill="#1c1917" />
    <path
      d="M8 12h2.5M14 7.5l-3.5 4.5 3.5 4.5"
      stroke="#e7e5e4"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle cx="7" cy="12" r="2" fill="#93c5fd" />
    <circle cx="16" cy="7" r="2" fill="#fcd34d" />
    <circle cx="16" cy="17" r="2" fill="#86efac" />
  </svg>
);

export const OutlineIcon = (props: IconProps) => (
  <Icon class={props.class}>
    <path d="M7.5 5h9M10 10h6.5M10 15h6.5" />
    <path d="M3.5 5h.01M6 10h.01M6 15h.01" stroke-width="2.4" />
  </Icon>
);
