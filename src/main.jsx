import React from "react";
import { createRoot } from "react-dom/client";
import Polysiege from "../Polysiege.jsx";

if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = window.localStorage.getItem(key);
      return value === null ? null : { value };
    },
    async set(key, value) {
      window.localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      window.localStorage.removeItem(key);
      return true;
    },
  };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Polysiege />
  </React.StrictMode>
);
