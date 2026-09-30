import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./console-refinement.css";
import "./marketing-refinement.css";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
