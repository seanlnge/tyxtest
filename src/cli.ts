#!/usr/bin/env node
import { main } from "./commands/main.js";

process.exitCode = await main(process.argv.slice(2));
