#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { makeServer } from "../lib/server.js";

const token = process.env["READABILITY_TOKEN"]
  ?? (process.env["READABILITY_TOKEN_FILE"] ? readFileSync(process.env["READABILITY_TOKEN_FILE"]!, "utf8").trim() : "");
if (!token) { console.error("readability: READABILITY_TOKEN[_FILE] required"); process.exit(1); }
const port = Number(process.env["PORT"] ?? "8080");
makeServer({ token }).listen(port, () => console.log(`readability: listening on ${port}`));
