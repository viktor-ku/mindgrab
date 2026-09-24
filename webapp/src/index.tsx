/* @refresh reload */
import { RouterProvider } from "@tanstack/solid-router";
import { render } from "solid-js/web";
import { router } from "./router.tsx";
import "./index.css";

const root = document.getElementById("root");

render(() => <RouterProvider router={router} />, root!);
