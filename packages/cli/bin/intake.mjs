#!/usr/bin/env node
// Launcher: registers tsx so the TypeScript source runs directly, then starts the CLI.
import { register } from "tsx/esm/api";

register();
await import("../src/bin.ts");
